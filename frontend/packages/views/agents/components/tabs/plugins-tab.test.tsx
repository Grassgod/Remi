// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enPlugins from "../../../locales/en/plugins.json";

const fixture = vi.hoisted(() => ({
  bindings: [] as unknown[],
  plugins: [] as unknown[],
  states: [] as unknown[],
  versions: new Map<string, unknown[]>(),
}));
const createBinding = vi.hoisted(() => vi.fn());
const updateBinding = vi.hoisted(() => vi.fn());
const deleteBinding = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ runtimeDetail: (id: string) => `/runtimes/${id}` }),
}));
vi.mock("@multiremi/core/plugins", () => ({
  agentPluginBindingsOptions: () => ({
    queryKey: ["agent", "plugins"],
    queryFn: () => Promise.resolve(fixture.bindings),
  }),
  pluginListOptions: () => ({
    queryKey: ["plugins", "claude"],
    queryFn: () => Promise.resolve(fixture.plugins),
  }),
  pluginRuntimeStatesOptions: (_wsId: string, pluginId: string) => ({
    queryKey: ["plugins", pluginId, "runtimes"],
    queryFn: () => Promise.resolve(fixture.states),
  }),
  pluginVersionsOptions: (_wsId: string, pluginId: string) => ({
    queryKey: ["plugins", pluginId, "versions"],
    queryFn: () => Promise.resolve(fixture.versions.get(pluginId) ?? []),
    enabled: Boolean(pluginId),
  }),
  useCreateAgentPluginBinding: () => ({
    mutateAsync: createBinding,
    isPending: false,
  }),
  useUpdateAgentPluginBinding: () => ({
    mutateAsync: updateBinding,
    isPending: false,
  }),
  useDeleteAgentPluginBinding: () => ({
    mutateAsync: deleteBinding,
    isPending: false,
  }),
  useRetryAgentPluginRuntime: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("../../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PluginsTab } from "./plugins-tab";

const resources = { en: { common: enCommon, plugins: enPlugins } };
const agent = {
  id: "agent-1",
  workspace_id: "ws-1",
  runtime_id: "",
  provider: "claude",
  name: "Reviewer",
  skills: [],
} as unknown as Agent;

function renderTab(canEdit: boolean, provider: "claude" | "codex" = "claude") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <PluginsTab agent={agent} provider={provider} canEdit={canEdit} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("Agent PluginsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createBinding.mockResolvedValue({ id: "binding-1" });
    updateBinding.mockResolvedValue({ id: "binding-1" });
    fixture.bindings = [];
    fixture.states = [];
    fixture.versions = new Map([
      [
        "claude-plugin",
        [
          { id: "v1", pluginId: "claude-plugin", version: "1.0.0" },
          { id: "v0", pluginId: "claude-plugin", version: "0.9.0" },
        ],
      ],
      [
        "codex-plugin",
        [{ id: "v2", pluginId: "codex-plugin", version: "1.0.0" }],
      ],
    ]);
    fixture.plugins = [
      {
        id: "claude-plugin",
        provider: "claude",
        name: "Claude review",
        activeVersion: { id: "v1", version: "1.0.0" },
        candidateVersion: null,
      },
      {
        id: "codex-plugin",
        provider: "codex",
        name: "Codex review",
        activeVersion: { id: "v2", version: "1.0.0" },
        candidateVersion: null,
      },
    ];
  });

  it("offers only provider-compatible plugins and creates a binding", async () => {
    const user = userEvent.setup();
    renderTab(true);

    const addButtons = await screen.findAllByRole("button", { name: "Add plugin" });
    await user.click(addButtons[0]!);
    const pluginSelect = screen.getByRole("combobox", { name: "Plugin" });
    await user.click(pluginSelect);

    const option = await screen.findByRole("option", { name: "Claude review" });
    expect(option).toBeInTheDocument();
    expect(screen.queryByText("Codex review")).not.toBeInTheDocument();
    await user.click(option);
    expect(pluginSelect).toHaveTextContent("Claude review");
    expect(pluginSelect).not.toHaveTextContent("claude-plugin");

    const policySelect = screen.getByRole("combobox", {
      name: "Version policy",
    });
    expect(policySelect).toHaveTextContent("Follow active version");
    expect(policySelect).not.toHaveTextContent("follow_active");
    await user.click(screen.getByRole("button", { name: /^Attach$/i }));

    expect(createBinding).toHaveBeenCalledWith({
      pluginId: "claude-plugin",
      versionPolicy: "follow_active",
      versionId: null,
      enabled: true,
    });
  });

  it("offers Codex plugins to a Codex agent", async () => {
    const user = userEvent.setup();
    renderTab(true, "codex");

    const addButtons = await screen.findAllByRole("button", { name: "Add plugin" });
    await user.click(addButtons[0]!);
    await user.click(screen.getByRole("combobox", { name: "Plugin" }));

    expect(
      await screen.findByRole("option", { name: "Codex review" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Claude review")).not.toBeInTheDocument();
  });

  it("renders existing bindings read-only without mutation controls", async () => {
    fixture.bindings = [
      {
        id: "binding-1",
        pluginId: "claude-plugin",
        versionPolicy: "follow_active",
        versionId: null,
        enabled: true,
        plugin: {
          id: "claude-plugin",
          provider: "claude",
          name: "Claude review",
        },
        resolvedVersion: { version: "1.0.0" },
      },
    ];
    renderTab(false);

    expect(await screen.findByText("Claude review")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Remove plugin" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add plugin" })).not.toBeInTheDocument();
  });

  it("edits the version policy using the full version history", async () => {
    const user = userEvent.setup();
    fixture.bindings = [
      {
        id: "binding-1",
        pluginId: "claude-plugin",
        versionPolicy: "follow_active",
        versionId: null,
        enabled: true,
        plugin: {
          id: "claude-plugin",
          provider: "claude",
          name: "Claude review",
          activeVersion: { id: "v1", version: "1.0.0" },
          candidateVersion: null,
        },
        resolvedVersion: { id: "v1", version: "1.0.0" },
      },
    ];
    renderTab(true);

    await user.click(
      await screen.findByRole("button", { name: "Change version policy" }),
    );
    const policySelect = screen.getByRole("combobox", {
      name: "Version policy",
    });
    await user.click(policySelect);
    await user.click(
      await screen.findByRole("option", { name: "Pin version" }),
    );
    expect(policySelect).toHaveTextContent("Pin version");
    expect(policySelect).not.toHaveTextContent("pinned");

    const versionSelect = screen.getByRole("combobox", { name: "Version" });
    await user.click(versionSelect);
    await user.click(await screen.findByRole("option", { name: "0.9.0" }));
    expect(versionSelect).toHaveTextContent("0.9.0");
    expect(versionSelect).not.toHaveTextContent("v0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateBinding).toHaveBeenCalledWith({
      bindingId: "binding-1",
      input: {
        versionPolicy: "pinned",
        versionId: "v0",
      },
    });
  });
});
