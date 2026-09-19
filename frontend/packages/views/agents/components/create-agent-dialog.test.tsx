// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import type {
  Agent,
  FleetModelsResponse,
  RuntimeModel,
  RuntimeModelThinkingLevel,
} from "@multiremi/core/types";
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

vi.mock("./execution-target-select", () => ({
  ExecutionTargetSelect: ({ onChange }: { onChange: (target: { executionGroupId: string; provider: string }) => void }) => (
    <>{["claude", "codex"].map((provider) => <button key={provider} onClick={() => onChange({ executionGroupId: `group-${provider}`, provider })}>{provider}</button>)}</>
  ),
}));

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

vi.mock("./model-dropdown", () => ({
  ModelDropdown: ({
    value,
    onChange,
    fallback,
  }: {
    value: string;
    onChange: (value: string) => void;
    fallback?: boolean;
  }) => (
    <input
      aria-label={fallback ? "Fallback model" : "Model"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("./inspector/thinking-picker", () => ({
  ThinkingPicker: ({
    value,
    levels,
    onChange,
  }: {
    value: string;
    levels: RuntimeModelThinkingLevel[];
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label="Reasoning effort"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Follow runtime default</option>
      {levels.map((level) => (
        <option key={level.value} value={level.value}>
          {level.label}
        </option>
      ))}
      {value && !levels.some((level) => level.value === value) && (
        <option value={value}>{value}</option>
      )}
    </select>
  ),
}));

// Provider logos pull in SVGs that don't matter for these assertions.
vi.mock("../../runtimes/components/provider-logo", () => ({
  ProviderLogo: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { CreateAgentDialog } from "./create-agent-dialog";

const CLAUDE_MODELS: RuntimeModel[] = [
  {
    id: "claude-sonnet",
    label: "Sonnet",
    default: true,
    thinking: {
      supported_levels: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    },
  },
  {
    id: "claude-haiku",
    label: "Haiku",
    thinking: {
      supported_levels: [{ value: "low", label: "Low" }],
    },
  },
];

function fleetWithCapacity(
  counts: Record<string, number>,
  models: Record<string, RuntimeModel[]> = {},
): FleetModelsResponse {
  return {
    providers: Object.entries(counts).map(([provider, online]) => ({
      provider,
      online_runtime_count: online,
      models: models[provider] ?? [],
    })),
  };
}

function makeTemplate(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-template",
    workspace_id: "ws-1",
    runtime_id: "",
    execution_group_id: "group-codex",
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

describe("CreateAgentDialog (execution targets)", () => {
  it.each(["unknown", "error"])("preserves duplicate settings but blocks an unexecutable model with catalog status %s", async (model_catalog_status) => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status, models: [{ id: "inventory-only", label: "Inventory only", execution_status: model_catalog_status === "unknown" ? "unknown" : "unavailable" }] }] });
    const { onCreate } = renderDialog(makeTemplate({ provider: "codex", model: "inventory-only", thinking_level: "saved-effort" }));
    expect(await screen.findByText(model_catalog_status === "unknown" ? "Execution capability unknown · Refreshing catalog" : "Not in execution catalog · Cannot run")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("inventory-only");
    // The model declares no levels, so the draft's effort is no longer an
    // editable picker — it stays visible as a read-only value. The model is
    // not editable here either, so no clear control is offered.
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    expect(screen.getByText("saved-effort")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear the override/i })).toBeNull();
    expect(createButton()).toBeDisabled();
    fireEvent.click(createButton());
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("prevents duplicating a model absent from the execution catalog while retaining the draft settings", async () => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "ready", models: [] }] });
    const { onCreate } = renderDialog(makeTemplate({ provider: "codex", model: "inventory-only", thinking_level: "saved-effort" }));
    expect(await screen.findByText("Not in execution catalog · Cannot run")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("inventory-only");
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    expect(screen.getByText("saved-effort")).toBeInTheDocument();
    const button = createButton();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCreate).not.toHaveBeenCalled();
  });

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

  it("creates with the explicitly selected machine and Runtime type", async () => {
    const { onCreate } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "claude" }));

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Pool Agent" },
    });
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const payload = onCreate.mock.calls[0]?.[0];
    expect(payload.provider).toBe("claude");
    expect(payload.execution_group_id).toBe("group-claude");
    expect(payload).not.toHaveProperty("runtime_id");
    expect(mockListFleetModels).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "ws-1", execution_group_id: "group-claude" }));
  });

  it("switching the engine toggles the submitted provider", async () => {
    const { onCreate } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "claude" }));

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Codex Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /codex/i }));
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0].provider).toBe("codex");
  });

  it("resets model and reasoning when choosing another machine of the same type", async () => {
    const { onCreate } = renderDialog(makeTemplate({ execution_group_id: "other-codex", model: "machine-only-model", thinking_level: "high" }));
    fireEvent.click(screen.getByRole("button", { name: "codex" }));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ execution_group_id: "group-codex", provider: "codex", model: undefined });
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("thinking_level");
  });

  it("saves a distinct fallback with its own supported reasoning effort", async () => {
    mockListFleetModels.mockResolvedValue(fleetWithCapacity({ claude: 2 }, { claude: CLAUDE_MODELS }));
    const { onCreate } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), { target: { value: "Research" } });
    await waitFor(() => expect(mockListFleetModels).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Fallback model"), { target: { value: "claude-haiku" } });
    fireEvent.change(screen.getByRole("group", { name: "Fallback reasoning effort" }).querySelector("select")!, { target: { value: "low" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ fallback_model: "claude-haiku", fallback_thinking_level: "low" });
  });

  it("blocks a fallback matching the catalog default and clears fallback on target change", async () => {
    mockListFleetModels.mockResolvedValue(fleetWithCapacity({ claude: 2, codex: 1 }, { claude: CLAUDE_MODELS }));
    const { onCreate } = renderDialog(makeTemplate({ provider: "claude", model: "", fallback_model: "claude-sonnet", fallback_thinking_level: "high" }));
    await waitFor(() => expect(screen.getByText("Must differ from the primary model")).toBeInTheDocument());
    expect(createButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "codex" }));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ fallback_model: undefined, fallback_thinking_level: undefined });
  });

  it("rejects a fallback effort unsupported by its own model", async () => {
    mockListFleetModels.mockResolvedValue(fleetWithCapacity({ claude: 2 }, { claude: CLAUDE_MODELS }));
    const { onCreate } = renderDialog(makeTemplate({ provider: "claude", model: "claude-sonnet", fallback_model: "claude-haiku", fallback_thinking_level: "high" }));
    await waitFor(() => expect(mockListFleetModels).toHaveBeenCalled());
    expect(createButton()).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("duplicate mode inherits the template's engine", async () => {
    const { onCreate } = renderDialog(makeTemplate({ provider: "codex" }));

    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0].provider).toBe("codex");
  });

  it("creates an automatically scheduled agent without requiring a machine or group", async () => {
    const { onCreate } = renderDialog();
    expect(createButton().disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Named" },
    });
    expect(createButton().disabled).toBe(false);
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ name: "Named", provider: "claude" });
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("execution_group_id");
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("runtime_id");
  });

  it("keeps an explicitly pinned runtime when duplicating an existing agent", async () => {
    const { onCreate } = renderDialog(makeTemplate({ runtime_id: "legacy-runtime", execution_group_id: "migrated-group" }));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ runtime_id: "legacy-runtime" });
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("execution_group_id");
  });

  it("creates with a model-supported reasoning effort", async () => {
    mockListFleetModels.mockResolvedValue(
      fleetWithCapacity({ claude: 2, codex: 1 }, { claude: CLAUDE_MODELS }),
    );
    const { onCreate } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "claude" }));

    const effort = await screen.findByRole("combobox", {
      name: "Reasoning effort",
    });
    expect((effort as HTMLSelectElement).value).toBe("");
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Deep Research" },
    });
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      model: undefined,
      thinking_level: "high",
    });
  });

  it("does not infer effort capabilities from the first model when no default is declared", async () => {
    const modelsWithoutDefault = CLAUDE_MODELS.map((entry) => ({
      ...entry,
      default: undefined,
    }));
    mockListFleetModels.mockResolvedValue(
      fleetWithCapacity(
        { claude: 2, codex: 1 },
        { claude: modelsWithoutDefault },
      ),
    );
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "claude" }));

    await waitFor(() => expect(mockListFleetModels).toHaveBeenCalled());
    expect(
      screen.queryByRole("combobox", { name: "Reasoning effort" }),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-sonnet" },
    });
    expect(
      screen.getByRole("combobox", { name: "Reasoning effort" }),
    ).toBeInTheDocument();
  });

  it("falls back to the runtime default when the next model does not support the selected effort", async () => {
    mockListFleetModels.mockResolvedValue(
      fleetWithCapacity({ claude: 2, codex: 1 }, { claude: CLAUDE_MODELS }),
    );
    const { onCreate } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "claude" }));

    const effort = await screen.findByRole("combobox", {
      name: "Reasoning effort",
    });
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-haiku" },
    });
    expect((effort as HTMLSelectElement).value).toBe("");

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "Fast Agent" },
    });
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0].model).toBe("claude-haiku");
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("thinking_level");
  });

  it("shows a duplicated orphan effort read-only and clears it with the explicit control", async () => {
    const { onCreate } = renderDialog(
      makeTemplate({
        model: "claude-retired",
        thinking_level: "xhigh",
      }),
    );

    // No editable picker for a model that declares no levels: the stored
    // effort is displayed read-only next to a clear control.
    expect(await screen.findByText("xhigh")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Clear the override/i }));
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("thinking_level");
  });

  it("keeps the editable picker when the catalog load failed instead of treating it as level-less", async () => {
    // A failed load is not an authoritative "no levels" verdict, so the picker
    // (and its clear row) must stay reachable for the saved effort.
    mockListFleetModels.mockRejectedValue(new Error("catalog unreachable"));
    renderDialog(makeTemplate({ provider: "claude", model: "claude-gateway-only", thinking_level: "high" }));

    const effort = await screen.findByRole("combobox", { name: "Reasoning effort" });
    expect((effort as HTMLSelectElement).value).toBe("high");
    expect(screen.getByText("Reasoning capability loading failed")).toBeInTheDocument();
  });

  it("keeps the editable fallback picker when the catalog load failed", async () => {
    mockListFleetModels.mockRejectedValue(new Error("catalog unreachable"));
    renderDialog(makeTemplate({
      provider: "claude",
      model: "claude-sonnet",
      fallback_model: "claude-gateway-only",
      fallback_thinking_level: "high",
    }));

    const fallbackGroup = await screen.findByRole("group", { name: "Fallback reasoning effort" });
    // Wait for the failed load to settle: only then is the picker guaranteed
    // to be the load-failure branch rather than the still-loading state.
    expect(await within(fallbackGroup).findByText("Reasoning capability loading failed")).toBeInTheDocument();
    const effort = fallbackGroup.querySelector("select");
    expect(effort).not.toBeNull();
    expect((effort as HTMLSelectElement).value).toBe("high");
  });

  it("shows a level-less fallback effort read-only and clears it", async () => {
    mockListFleetModels.mockResolvedValue(fleetWithCapacity({ claude: 2 }, { claude: CLAUDE_MODELS }));
    const { onCreate } = renderDialog(makeTemplate({
      provider: "claude",
      model: "claude-sonnet",
      fallback_model: "claude-retired",
      fallback_thinking_level: "xhigh",
    }));

    const fallbackGroup = await screen.findByRole("group", { name: "Fallback reasoning effort" });
    expect(await screen.findByText("xhigh")).toBeInTheDocument();
    expect(fallbackGroup.querySelector("select")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Clear the override/i }));
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ fallback_model: "claude-retired" });
    // Cleared: the create payload omits the fallback effort (undefined keys are
    // dropped on the wire), so the stored orphan value can no longer survive.
    expect(onCreate.mock.calls[0]?.[0].fallback_thinking_level).toBeUndefined();
  });
});
