// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AgentRuntime } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

// AgentOverviewPane pulls in ActorIssuesPanel which in turn touches the api
// layer. The test only cares about which top-of-pane tab buttons render,
// not what each tab does, so we stub the heavy children.
vi.mock("./tabs/activity-tab", () => ({
  ActivityTab: () => <div>activity-tab</div>,
}));
vi.mock("./tabs/instructions-tab", () => ({
  InstructionsTab: () => <div>instructions-tab</div>,
}));
vi.mock("./tabs/skills-tab", () => ({
  SkillsTab: () => <div>skills-tab</div>,
}));
vi.mock("./tabs/plugins-tab", () => ({
  PluginsTab: () => <div>plugins-tab</div>,
}));
vi.mock("./tabs/env-tab", () => ({
  EnvTab: () => <div>env-tab</div>,
}));
vi.mock("./tabs/custom-args-tab", () => ({
  CustomArgsTab: () => <div>custom-args-tab</div>,
}));
vi.mock("./tabs/mcp-config-tab", () => ({
  McpConfigTab: () => <div>mcp-config-tab</div>,
}));
vi.mock("./tabs/integrations-tab", () => ({
  IntegrationsTab: () => <div>integrations-tab</div>,
}));
vi.mock("../../common/actor-issues-panel", () => ({
  ActorIssuesPanel: () => <div>actor-issues-panel</div>,
}));

// The pane now reads workspace context to decide whether the Integrations
// tab is worth showing (it queries Lark installations to learn whether the
// deployment has the feature configured). Provide a stable workspace id and
// a listing query backed by a ref so each test can flip `configured`.
const larkListingRef = vi.hoisted(() => ({
  current: { installations: [] as unknown[], configured: false },
}));
vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));
vi.mock("@multiremi/core/lark", () => ({
  larkInstallationsOptions: () => ({
    queryKey: ["lark", "installations"],
    queryFn: () => Promise.resolve(larkListingRef.current),
  }),
}));

import { AgentOverviewPane } from "./agent-overview-pane";

const baseAgent: Agent = {
  id: "agent-1",
  workspace_id: "ws-1",
  runtime_id: "runtime-1",
  name: "Agent",
  description: "",
  instructions: "",
  avatar_url: null,
  runtime_mode: "local",
  runtime_config: {},
  custom_args: [],
  visibility: "workspace",
  status: "idle",
  max_concurrent_tasks: 1,
  model: "",
  owner_id: "user-1",
  skills: [],
  created_at: "2026-05-28T00:00:00Z",
  updated_at: "2026-05-28T00:00:00Z",
  archived_at: null,
  archived_by: null,
};

function makeRuntime(provider: string): AgentRuntime {
  return {
    id: "runtime-1",
    workspace_id: "ws-1",
    daemon_id: null,
    name: "Runtime",
    runtime_mode: "local",
    provider,
    launch_header: "",
    status: "online",
    device_info: "",
    metadata: {},
    owner_id: null,
    visibility: "private",
    last_seen_at: null,
    created_at: "2026-05-28T00:00:00Z",
    updated_at: "2026-05-28T00:00:00Z",
  };
}

function renderPane(runtimes: AgentRuntime[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <AgentOverviewPane
          agent={baseAgent}
          runtimes={runtimes}
          onUpdate={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  larkListingRef.current = { installations: [], configured: false };
});

describe("AgentOverviewPane MCP tab visibility", () => {
  it.each([
    ["Claude", "claude"],
    ["Codex", "codex"],
    ["Hermes", "hermes"],
    ["Kimi", "kimi"],
    ["Kiro", "kiro"],
    ["OpenCode", "opencode"],
    ["OpenClaw", "openclaw"],
  ])("renders the MCP tab when the agent runs on the %s runtime", (_label, provider) => {
    renderPane([makeRuntime(provider)]);
    expect(screen.getByRole("tab", { name: /^MCP$/i })).toBeInTheDocument();
  });

  it("hides the MCP tab for providers whose backend does not read mcp_config", () => {
    // Saving an MCP config on e.g. Gemini would be a silent no-op at run
    // time — that's the bug this hiding logic is meant to prevent.
    renderPane([makeRuntime("gemini")]);
    expect(
      screen.queryByRole("tab", { name: /^MCP$/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the MCP tab visible when the runtime row hasn't loaded yet", () => {
    // Empty runtimes[] mimics the brief window between the page mounting and
    // the runtimes query resolving. Hiding the tab would flicker it off and
    // then back on, which reads as a bug.
    renderPane([]);
    expect(screen.getByRole("tab", { name: /^MCP$/i })).toBeInTheDocument();
  });
});

describe("AgentOverviewPane tab semantics", () => {
  it("exposes the strip as a tablist whose active tab controls a panel", () => {
    renderPane([makeRuntime("claude")]);

    const list = screen.getByRole("tablist");
    expect(list).toBeInTheDocument();

    const activity = screen.getByRole("tab", { name: /^Activity$/i });
    expect(activity).toHaveAttribute("aria-selected", "true");

    // The panel exists and is the one the active tab points at — without a
    // registered panel the tab would announce as controlling nothing.
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("activity-tab");
    expect(activity.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("switches the rendered panel when another tab is activated", async () => {
    const user = userEvent.setup();
    renderPane([makeRuntime("claude")]);

    await user.click(screen.getByRole("tab", { name: /^Instructions$/i }));

    expect(screen.getByRole("tabpanel")).toHaveTextContent("instructions-tab");
    expect(screen.queryByText("activity-tab")).not.toBeInTheDocument();
  });

  it("places provider plugins directly after skills", () => {
    renderPane([makeRuntime("claude")]);

    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());
    expect(tabs.indexOf("Plugins")).toBe(tabs.indexOf("Skills") + 1);
  });

  it("hides plugins for unsupported providers", () => {
    renderPane([makeRuntime("gemini")]);
    expect(screen.queryByRole("tab", { name: /^Plugins$/i })).not.toBeInTheDocument();
  });
});

describe("AgentOverviewPane Integrations tab visibility", () => {
  it("shows the Integrations tab once the deployment has Lark configured", async () => {
    larkListingRef.current = { installations: [], configured: true };
    renderPane([makeRuntime("claude")]);
    expect(
      await screen.findByRole("tab", { name: /^Integrations$/i }),
    ).toBeInTheDocument();
  });

  it("hides the Integrations tab when Lark is not configured", () => {
    // Default ref is configured:false; the tab must not appear on
    // deployments without the integration, which are the common case.
    renderPane([makeRuntime("claude")]);
    expect(
      screen.queryByRole("tab", { name: /^Integrations$/i }),
    ).not.toBeInTheDocument();
  });
});
