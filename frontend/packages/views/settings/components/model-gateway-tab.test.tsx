import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as "owner" | "admin" | "member" }],
  pending: false,
}));
const relayRef = vi.hoisted(() => ({
  current: {
    claude: { fragment: '{"env":{"ANTHROPIC_BASE_URL":"https://ai.openremi.fun"}}', hasToken: true, revision: 3 },
    codex: { fragment: "", hasToken: false, revision: 0 },
    modelDiscovery: true,
  } as Record<string, unknown> | undefined,
  pending: false,
  error: null as Error | null,
}));
const mockRefetchRelay = vi.hoisted(() => vi.fn());
const mockUpdateRelay = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSetDiscovery = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockProbeRelay = vi.hoisted(() => vi.fn());
const mockGetReasoningLevels = vi.hoisted(() => vi.fn());
const mockPutReasoningLevel = vi.hoisted(() => vi.fn());
const mockRefetchReasoning = vi.hoisted(() => vi.fn());
const reasoningRef = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  pending: false,
  error: null as Error | null,
}));
const mockInvalidateQueries = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());
const workspaceRef = vi.hoisted(() => ({
  current: {
    id: "workspace-1",
    slug: "acme",
    name: "Acme",
    settings: {} as Record<string, unknown>,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = JSON.stringify(opts?.queryKey ?? []);
    if (key.includes("relay-config")) {
      return {
        data: relayRef.error ? undefined : relayRef.current,
        isPending: relayRef.pending,
        isError: relayRef.error !== null,
        error: relayRef.error,
        refetch: mockRefetchRelay,
      };
    }
    if (key.includes("relay-reasoning-levels")) {
      const engine = String(opts?.queryKey?.[2] ?? "");
      return {
        data: reasoningRef.error ? undefined : reasoningRef.current[engine],
        isPending: reasoningRef.pending,
        isError: reasoningRef.error !== null,
        error: reasoningRef.error,
        refetch: mockRefetchReasoning,
      };
    }
    return { data: membersRef.current, isPending: membersRef.pending };
  },
  useQueryClient: () => ({ setQueryData: mockSetQueryData, invalidateQueries: mockInvalidateQueries }),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => workspaceRef.current,
}));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
  workspaceKeys: { list: () => ["workspaces", "list"] },
}));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: Object.assign(
    (sel?: (s: { user: { id: string } }) => unknown) => (sel ? sel({ user: { id: "user-1" } }) : { user: { id: "user-1" } }),
    { getState: () => ({ user: { id: "user-1" } }) },
  ),
}));
vi.mock("@multiremi/core/api", () => ({
  api: {
    getRelayConfig: vi.fn(() => Promise.resolve(relayRef.current)),
    updateRelayConfig: mockUpdateRelay,
    setRelayDiscovery: mockSetDiscovery,
    probeRelayEngine: mockProbeRelay,
    getRelayReasoningLevels: mockGetReasoningLevels,
    putRelayReasoningLevel: mockPutReasoningLevel,
    revealRelayToken: vi.fn(() => Promise.resolve("sk-revealed")),
    updateWorkspace: mockUpdateWorkspace,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ModelGatewayTab } from "./model-gateway-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };
function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("ModelGatewayTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    membersRef.current = [{ user_id: "user-1", role: "owner" }];
    membersRef.pending = false;
    relayRef.current = {
      claude: { fragment: '{"env":{"ANTHROPIC_BASE_URL":"https://ai.openremi.fun"}}', hasToken: true, revision: 3 },
      codex: { fragment: "", hasToken: false, revision: 0 },
      modelDiscovery: true,
    };
    relayRef.pending = false;
    relayRef.error = null;
    reasoningRef.current = {
      claude: { engine: "claude", allowed_levels: ["low", "medium", "high", "xhigh", "max"], models: [] },
      codex: { engine: "codex", allowed_levels: ["minimal", "low", "medium", "high", "xhigh", "max"], models: [] },
    };
    reasoningRef.pending = false;
    reasoningRef.error = null;
    mockPutReasoningLevel.mockReset();
    workspaceRef.current.settings = {};
    mockUpdateWorkspace.mockImplementation(async (_id: string, input: { settings: Record<string, unknown> }) => ({
      ...workspaceRef.current,
      settings: input.settings,
    }));
  });

  it("renders discovery toggle and both engine sections for an admin", () => {
    render(<ModelGatewayTab />, { wrapper: Wrapper });
    expect(screen.getByText("Auto-discover models")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Task progress summaries")).toBeInTheDocument();
    expect(screen.getByText("Issue automatic naming")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Automatic naming" })).toBeChecked();
    // claude fragment is pre-filled from server config
    expect(screen.getByDisplayValue(/ANTHROPIC_BASE_URL/)).toBeInTheDocument();
  });

  it("blocks non owner/admin members", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    render(<ModelGatewayTab />, { wrapper: Wrapper });
    expect(screen.getByText(/Only workspace owners and admins/)).toBeInTheDocument();
    expect(screen.queryByText("Auto-discover models")).not.toBeInTheDocument();
  });

  it("saves the claude fragment with token_op keep when the token was untouched", async () => {
    render(<ModelGatewayTab />, { wrapper: Wrapper });
    const [claudeSaveButton] = screen.getAllByRole("button", { name: /^Save$/ });
    if (!claudeSaveButton) throw new Error("Claude save button not found");
    await userEvent.click(claudeSaveButton);
    await waitFor(() => expect(mockUpdateRelay).toHaveBeenCalled());
    expect(mockUpdateRelay).toHaveBeenCalledWith(
      "workspace-1",
      "claude",
      expect.objectContaining({ token_op: "keep", fragment: expect.stringContaining("ANTHROPIC_BASE_URL") }),
    );
  });

  it("persists allowlisted progress summary settings without dropping other workspace settings", async () => {
    workspaceRef.current.settings = {
      retained_setting: "yes",
      progress_summary: {
        transport: "openai",
        model: "claude-workspace",
        openai_model: "gpt-workspace",
        openai_api_key: "must-not-survive",
      },
    };
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByLabelText("OpenAI-compatible model")).toHaveValue("gpt-workspace");
    await user.clear(screen.getByLabelText("OpenAI-compatible model"));
    await user.type(screen.getByLabelText("OpenAI-compatible model"), "gpt-custom");
    await user.click(screen.getByRole("button", { name: "Save summary settings" }));

    await waitFor(() => expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: {
        retained_setting: "yes",
        progress_summary: {
          transport: "openai",
          model: "claude-workspace",
          openai_model: "gpt-custom",
        },
      },
    }));
  });

  it("persists issue automatic naming settings without dropping other workspace settings", async () => {
    workspaceRef.current.settings = {
      retained_setting: "yes",
      issue_auto_title: {
        enabled: false,
        model: "gpt-old",
        auth_token: "must-not-survive",
      },
    };
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByRole("switch", { name: "Automatic naming" })).not.toBeChecked();
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-old");
    await user.click(screen.getByRole("switch", { name: "Automatic naming" }));
    await user.clear(screen.getByLabelText("Model"));
    await user.type(screen.getByLabelText("Model"), "gpt-5.6-luna-custom");
    await user.click(screen.getByRole("button", { name: "Save naming settings" }));

    await waitFor(() => expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: {
        retained_setting: "yes",
        issue_auto_title: {
          enabled: true,
          model: "gpt-5.6-luna-custom",
        },
      },
    }));
  });

  it("renders a skeleton instead of an empty savable form while the config loads", () => {
    relayRef.pending = true;
    relayRef.current = undefined;
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByTestId("model-gateway-skeleton")).toBeInTheDocument();
    // A blank textarea + live Save would PUT fragment:"" as a full replace
    // and wipe the fleet's relay config, so neither may exist yet.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("says the config failed to load and offers a retry", async () => {
    relayRef.error = new Error("relay unreachable");
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load the gateway configuration",
    );
    expect(screen.getByText("relay unreachable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetchRelay).toHaveBeenCalled();
  });

  it("waits for the member query before deciding the viewer lacks permission", () => {
    // `members` defaults to [] while in flight, which used to read as "no
    // role" and flashed the denial at owners deep-linking the tab.
    membersRef.pending = true;
    membersRef.current = [];
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.queryByText(/Only workspace owners and admins/)).not.toBeInTheDocument();
    expect(screen.getByTestId("model-gateway-skeleton")).toBeInTheDocument();
  });

  it("probes one engine on demand and refreshes the fleet model catalog", async () => {
    mockProbeRelay.mockResolvedValue({
      engine: "codex",
      status: "ready",
      error: null,
      models: [
        {
          id: "gpt-6-astra",
          label: "Astra",
          thinking: { status: "supported", supported_levels: [{ value: "high", label: "High" }] },
        },
        { id: "gpt-6-luna", label: "Luna" },
      ],
      last_success_at: "2026-09-19T06:00:00.000Z",
    });
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    const [, codexProbe] = screen.getAllByRole("button", { name: "Probe now" });
    if (!codexProbe) throw new Error("Codex probe button not found");
    await user.click(codexProbe);

    await waitFor(() => expect(mockProbeRelay).toHaveBeenCalledWith("workspace-1", "codex"));
    expect(await screen.findByText("2 models · effort high on 1/2 models")).toBeInTheDocument();
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["runtimes", "models", "fleet", "workspace-1"],
    }));
  });

  it("reports a gateway-declared absence of reasoning levels without calling it a failure", async () => {
    mockProbeRelay.mockResolvedValue({
      engine: "claude",
      status: "ready",
      error: null,
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      last_success_at: "2026-09-19T06:00:00.000Z",
    });
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    const [claudeProbe] = screen.getAllByRole("button", { name: "Probe now" });
    if (!claudeProbe) throw new Error("Claude probe button not found");
    await user.click(claudeProbe);

    expect(await screen.findByText("1 model · gateway declares no reasoning levels")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces the server's sanitized probe error inline", async () => {
    mockProbeRelay.mockResolvedValue({
      engine: "claude",
      status: "error",
      error: "gateway HTTP 502",
      models: [],
      last_success_at: null,
    });
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    const [claudeProbe] = screen.getAllByRole("button", { name: "Probe now" });
    if (!claudeProbe) throw new Error("Claude probe button not found");
    await user.click(claudeProbe);

    expect(await screen.findByRole("alert")).toHaveTextContent("gateway HTTP 502");
  });

  it("disables probing while auto-discovery is off", () => {
    relayRef.current = { ...relayRef.current, modelDiscovery: false };
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    for (const button of screen.getAllByRole("button", { name: "Probe now" })) {
      expect(button).toBeDisabled();
    }
  });

  it("saves manual reasoning levels and the default level for a gateway model", async () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: null,
        effective: null,
      }],
    };
    mockPutReasoningLevel.mockResolvedValue({
      deleted: false,
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: {
          levels: ["low", "high"],
          default_level: "high",
          updated_by: "owner@example.test",
          updated_at: "2026-09-19T08:10:00.000Z",
          state: "effective",
        },
        effective: {
          supported_levels: [{ value: "low", label: "low" }, { value: "high", label: "high" }],
          default_level: "high",
          status: "supported",
          source: "manual",
        },
      }],
    });
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByText("Not declared")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configure" }));
    await user.click(screen.getByRole("checkbox", { name: "low" }));
    await user.click(screen.getByRole("checkbox", { name: "high" }));
    await user.click(screen.getByRole("combobox", { name: "Default level" }));
    await user.click(await screen.findByRole("option", { name: "high" }));
    await user.click(screen.getByRole("button", { name: "Save levels" }));

    await waitFor(() => expect(mockPutReasoningLevel).toHaveBeenCalledWith("workspace-1", "claude", {
      model: "deepseek-v4-flash",
      levels: ["low", "high"],
      default_level: "high",
    }));
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["relay-reasoning-levels", "workspace-1", "claude"],
    }));
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["runtimes", "models", "fleet", "workspace-1"],
    }));
  });

  it("flags an outranked declaration with the existing conflict hint", () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: {
          levels: ["low", "high"],
          default_level: "high",
          updated_by: "owner@example.test",
          updated_at: "2026-09-19T08:10:00.000Z",
          state: "outranked",
        },
        effective: {
          supported_levels: [{ value: "low", label: "low" }, { value: "high", label: "high" }],
          default_level: "low",
          status: "supported",
          source: "gateway",
        },
      }],
    };
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByText("gateway")).toBeInTheDocument();
    expect(screen.getByText("Manual: low, high")).toBeInTheDocument();
    expect(screen.getByText("supported · Effective: low, high")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Overridden by the gateway declaration — the effective value comes from gateway.",
    );
  });

  it("renders the undeclared state for a model without any source", () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high"],
      models: [{ model_id: "deepseek-flash", label: "DeepSeek Flash", manual: null, effective: null }],
    };
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByText("Not declared")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears a manual declaration with an explicit empty levels payload", async () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: {
          levels: ["high"],
          default_level: "high",
          updated_by: "owner@example.test",
          updated_at: "2026-09-19T08:10:00.000Z",
          state: "effective",
        },
        effective: {
          supported_levels: [{ value: "high", label: "high" }],
          default_level: "high",
          status: "supported",
          source: "manual",
        },
      }],
    };
    mockPutReasoningLevel.mockResolvedValue({ deleted: true, engine: "claude", allowed_levels: [], models: [] });
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Configure" }));
    await user.click(screen.getByRole("button", { name: "Clear declaration" }));

    await waitFor(() => expect(mockPutReasoningLevel).toHaveBeenCalledWith(
      "workspace-1",
      "claude",
      { model: "deepseek-v4-flash", levels: [] },
    ));
  });

  it("surfaces a rejected reasoning-level save inline", async () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: null,
        effective: null,
      }],
    };
    mockPutReasoningLevel.mockRejectedValue(new Error('level "ultra" is not allowed for claude'));
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Configure" }));
    await user.click(screen.getByRole("checkbox", { name: "low" }));
    await user.click(screen.getByRole("button", { name: "Save levels" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      'level "ultra" is not allowed for claude',
    );
  });

  it("keeps manual declarations after a probe refresh", async () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: {
          levels: ["low", "high"],
          default_level: "high",
          updated_by: "owner@example.test",
          updated_at: "2026-09-19T08:10:00.000Z",
          state: "effective",
        },
        effective: {
          supported_levels: [{ value: "low", label: "low" }, { value: "high", label: "high" }],
          default_level: "high",
          status: "supported",
          source: "manual",
        },
      }],
    };
    mockProbeRelay.mockResolvedValue({
      engine: "claude",
      status: "ready",
      error: null,
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      last_success_at: "2026-09-19T08:20:00.000Z",
    });
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByText("Manual: low, high")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Probe now" })[0]!);

    await waitFor(() => expect(mockProbeRelay).toHaveBeenCalledWith("workspace-1", "claude"));
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["relay-reasoning-levels", "workspace-1", "claude"],
    }));
    expect(screen.getByText("Manual: low, high")).toBeInTheDocument();
  });
  it("adds a model manually when the engine has no probed models", async () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [],
    };
    mockPutReasoningLevel.mockResolvedValue({
      deleted: false,
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "deepseek-v4-flash",
        manual: {
          levels: ["low", "high"],
          default_level: "high",
          updated_by: "owner@example.test",
          updated_at: "2026-09-19T08:30:00.000Z",
          state: "effective",
        },
        effective: {
          supported_levels: [{ value: "low", label: "low" }, { value: "high", label: "high" }],
          default_level: "high",
          status: "supported",
          source: "manual",
        },
      }],
    });
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getAllByText(
      "No gateway models probed for this engine yet. You can still declare one manually.",
    ).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "Add model" })[0]!);
    await user.type(screen.getByLabelText("Model ID"), "deepseek-v4-flash");
    await user.click(screen.getByRole("checkbox", { name: "low" }));
    await user.click(screen.getByRole("checkbox", { name: "high" }));
    await user.click(screen.getByRole("combobox", { name: "Default level" }));
    await user.click(await screen.findByRole("option", { name: "high" }));
    await user.click(screen.getByRole("button", { name: "Save levels" }));

    await waitFor(() => expect(mockPutReasoningLevel).toHaveBeenCalledWith("workspace-1", "claude", {
      model: "deepseek-v4-flash",
      levels: ["low", "high"],
      default_level: "high",
    }));
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["relay-reasoning-levels", "workspace-1", "claude"],
    }));
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["runtimes", "models", "fleet", "workspace-1"],
    }));
  });

  it("renders a distinct blocked reason for every state code", () => {
    const blocked = (stateCode: string) => ({
      levels: ["high"],
      default_level: "high",
      updated_by: "owner@example.test",
      updated_at: "2026-09-19T08:40:00.000Z",
      state: "blocked",
      state_code: stateCode,
    });
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high"],
      models: [
        { model_id: "codex-absent", label: "Codex absent", manual: blocked("not_in_execution_catalog"), effective: null },
        { model_id: "codex-loading", label: "Codex loading", manual: blocked("execution_catalog_unknown"), effective: null },
        { model_id: "engine-absent", label: "Engine absent", manual: blocked("not_in_catalog"), effective: null },
      ],
    };
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getAllByText("Not effective")).toHaveLength(3);
    expect(screen.getByText(/not in the Codex execution catalog/)).toBeInTheDocument();
    expect(screen.getByText(/execution catalog is unknown or still loading/)).toBeInTheDocument();
    expect(screen.getByText(/not in the engine catalog/)).toBeInTheDocument();
    expect(screen.queryByText("Not declared")).toBeNull();
  });

  it("keeps an effective declaration in force without a conflict hint", () => {
    reasoningRef.current.claude = {
      engine: "claude",
      allowed_levels: ["low", "medium", "high"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: {
          levels: ["low", "high"],
          default_level: "high",
          updated_by: "owner@example.test",
          updated_at: "2026-09-19T08:50:00.000Z",
          state: "effective",
        },
        effective: {
          supported_levels: [{ value: "low", label: "low" }, { value: "high", label: "high" }],
          default_level: "high",
          status: "supported",
          source: "manual",
        },
      }],
    };
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("Manual: low, high")).toBeInTheDocument();
    expect(screen.queryByText("Not effective")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
