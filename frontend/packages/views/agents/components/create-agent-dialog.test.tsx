// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { Agent, FleetModelsResponse } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const navigationStub: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/",
  searchParams: new URLSearchParams(),
  getShareableUrl: (path: string) => path,
};

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const mockListFleetModels = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/api", () => ({
  api: {
    listFleetModels: (...args: unknown[]) => mockListFleetModels(...args),
    listSkills: vi.fn().mockResolvedValue([]),
    setAgentSkills: vi.fn().mockResolvedValue(undefined),
    addSquadMember: vi.fn().mockResolvedValue(undefined),
  },
}));

// ModelDropdown owns its own fleet query; the dialog only needs it as a
// stand-in here, so swap it out.
vi.mock("./model-dropdown", () => ({
  ModelDropdown: () => null,
}));

// Provider logos pull in SVGs that don't matter for these assertions.
vi.mock("../../runtimes/components/provider-logo", () => ({
  ProviderLogo: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { CreateAgentDialog } from "./create-agent-dialog";

function fleetWithCapacity(counts: Record<string, number>): FleetModelsResponse {
  return {
    providers: Object.entries(counts).map(([provider, online]) => ({
      provider,
      online_runtime_count: online,
      models: [],
    })),
  };
}

function makeTemplate(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-template",
    workspace_id: "ws-1",
    runtime_id: "",
    provider: "codex",
    name: "Template Agent",
    description: "",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: [],
    visibility: "private",
    status: "idle",
    max_concurrent_tasks: 1,
    model: "",
    owner_id: "user-me",
    skills: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function renderDialog(template?: Agent) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <WorkspaceSlugProvider slug="test-ws">
        <NavigationProvider value={navigationStub}>
          <CreateAgentDialog
            template={template}
            onClose={onClose}
            onCreate={onCreate}
          />
        </NavigationProvider>
        </WorkspaceSlugProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { onCreate, onClose };
}

function createButton(): HTMLButtonElement {
  const btn = screen
    .getAllByRole("button")
    .find((b) => b.textContent === "Create");
  expect(btn).toBeDefined();
  return btn as HTMLButtonElement;
}

describe("CreateAgentDialog (pool model)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFleetModels.mockResolvedValue(fleetWithCapacity({ claude: 2, codex: 1 }));
  });
  // Base UI Dialog renders into a portal on document.body and leaves
  // focus-guard / inert wrapper divs around after the React tree unmounts.
  // The auto-cleanup from @testing-library/react drops the container but
  // not the portal residue. Force cleanup + wipe body between tests.
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("creates without any machine choice — engine defaults to claude", async () => {
    const { onCreate } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Pool Agent" },
    });
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const payload = onCreate.mock.calls[0]?.[0];
    expect(payload.provider).toBe("claude");
    expect(payload.runtime_id).toBeUndefined();
  });

  it("switching the engine toggles the submitted provider", async () => {
    const { onCreate } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Codex Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /codex/i }));
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0].provider).toBe("codex");
  });

  it("duplicate mode inherits the template's engine", async () => {
    const { onCreate } = renderDialog(makeTemplate({ provider: "codex" }));

    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0].provider).toBe("codex");
  });

  it("shows the no-capacity hint when the selected engine has no online machine", async () => {
    mockListFleetModels.mockResolvedValue(fleetWithCapacity({ claude: 0, codex: 1 }));
    renderDialog();

    expect(
      await screen.findByText(/No online machine for this engine/i),
    ).toBeInTheDocument();

    // Creation stays allowed — the task queues server-side.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Queued Agent" },
    });
    expect(createButton().disabled).toBe(false);
  });

  it("gates Create on the name only", () => {
    renderDialog();
    expect(createButton().disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Named" },
    });
    expect(createButton().disabled).toBe(false);
  });
});
