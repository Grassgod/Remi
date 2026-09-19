// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FleetModelsResponse, RuntimeModel } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enAgents from "../../../locales/en/agents.json";
import zhAgents from "../../../locales/zh-Hans/agents.json";
import jaAgents from "../../../locales/ja/agents.json";
import koAgents from "../../../locales/ko/agents.json";
import type { SupportedLocale } from "@multiremi/core/i18n";
import enIssues from "../../../locales/en/issues.json";

const TEST_RESOURCES = {
  en: { common: enCommon, agents: enAgents, issues: enIssues },
  "zh-Hans": { common: enCommon, agents: zhAgents, issues: enIssues },
  ja: { common: enCommon, agents: jaAgents, issues: enIssues },
  ko: { common: enCommon, agents: koAgents, issues: enIssues },
};

const mockListFleetModels = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/api", () => ({
  api: {
    listFleetModels: (...args: unknown[]) => mockListFleetModels(...args),
  },
}));

import { ThinkingPropRow } from "./thinking-prop-row";

const CLAUDE_MODEL: RuntimeModel = {
  id: "claude-sonnet-4-6",
  label: "Claude Sonnet 4.6",
  default: true,
  thinking: {
    supported_levels: [
      { value: "none", label: "None" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    default_level: "medium",
  },
};

// Model without thinking metadata — what the row sees when the agent's
// model swap landed on a non-thinking provider, or when the group catalog
// shrank and stopped emitting `thinking` for this id.
const NO_THINKING_MODEL: RuntimeModel = {
  id: "gemini-2.5-pro",
  label: "Gemini 2.5 Pro",
  default: true,
};

function fleet(models: RuntimeModel[]): FleetModelsResponse {
  return {
    providers: [{ provider: "claude", online_runtime_count: 1, models }],
  };
}

function renderRow(
  props: Partial<React.ComponentProps<typeof ThinkingPropRow>> = {},
  locale: SupportedLocale = "en",
) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    // PropRow uses CSS subgrid, so wrap with the same column tracks the
    // inspector parent declares — otherwise the row mounts without a
    // grid context and the column layout warns. Behaviour we care about
    // (visibility + clear flow) is independent of layout.
    <I18nProvider locale={locale} resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          <ThinkingPropRow
            wsId="ws-1"
            executionGroupId="group-1"
            agentId="agent-1"
            provider="claude"
            model="claude-sonnet-4-6"
            value=""
            canEdit
            onChange={onChange}
            {...props}
          />
        </div>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...utils, onChange, queryClient };
}

describe("ThinkingPropRow", () => {
  it.each([
    ["en", "Not in execution catalog · Cannot run"],
    ["zh-Hans", "不在执行目录 / 不可执行"],
    ["ja", "実行カタログにないため実行できません"],
    ["ko", "실행 카탈로그에 없어 실행할 수 없습니다"],
  ] as const)("shows unavailable instead of unknown and preserves saved reasoning in %s", async (locale, message) => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "ready", models: [] }] });
    const { onChange } = renderRow({ provider: "codex", model: "inventory-only", value: "saved-effort" }, locale);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText("Reasoning capability unknown")).toBeNull();
    expect(screen.getByText("saved-effort")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders gateway-native levels and high default and emits the selected max", async () => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", online_runtime_count: 1, models: [{
      id: "deepseek-flash", label: "DeepSeek Flash", thinking: {
        status: "supported", default_level: "high",
        supported_levels: ["low", "high", "max"].map(value => ({ value, label: value })),
      },
    }] }] });
    const { onChange } = renderRow({ provider: "codex", model: "deepseek-flash" });
    expect(await screen.findByText("Model default: high")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("low")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    fireEvent.click(screen.getByText("max"));
    expect(onChange).toHaveBeenCalledWith("max");
  });

  it("shows an authoritative capability error while preserving a saved override", async () => {
    mockListFleetModels.mockResolvedValue(fleet([{ ...CLAUDE_MODEL, thinking: {
      supported_levels: [{ value: "high", label: "High" }], status: "error",
    } }]));
    const { onChange } = renderRow({ value: "max" });
    expect(await screen.findByText("Reasoning capability loading failed")).toBeInTheDocument();
    expect(await screen.findByText("max")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("High")).toBeNull();
  });

  it("shows the advertised model default without overwriting the runtime override", async () => {
    const { onChange } = renderRow();
    expect(await screen.findByText("Model default: Medium")).toBeInTheDocument();
    expect(screen.getByText("Follow runtime default")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFleetModels.mockResolvedValue(fleet([CLAUDE_MODEL]));
  });

  afterEach(() => {
    cleanup();
  });

  it("lets the default model select common reported efforts on an older daemon", async () => {
    mockListFleetModels.mockResolvedValue(fleet([
      { ...CLAUDE_MODEL, default: false },
      { id: "opus", label: "Opus", thinking: { supported_levels: [{ value: "high", label: "High" }] } },
      { id: "haiku", label: "Haiku" },
    ]));
    const { onChange } = renderRow({ model: "", executionGroupId: null });
    await screen.findByText("Follow runtime default");
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByText("High"));
    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByText("Low")).toBeNull();
  });

  it("prefers the provider default capability to concrete model metadata", async () => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "claude", online_runtime_count: 1,
      models: [{ ...CLAUDE_MODEL, default: false }],
      default_thinking: { supported_levels: [{ value: "max", label: "Max" }] },
    }] });
    const { onChange } = renderRow({ model: "" });
    await screen.findByText("Follow runtime default");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("High")).toBeNull();
    fireEvent.click(await screen.findByText("Max"));
    expect(onChange).toHaveBeenCalledWith("max");
  });

  it("does not replace a reported empty default capability with a heuristic", async () => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "claude", online_runtime_count: 1,
      models: [CLAUDE_MODEL], default_thinking: { supported_levels: [] },
    }] });
    renderRow({ model: "" });
    expect(await screen.findByText("Reasoning configuration not supported")).toBeInTheDocument();
  });

  it("shows unknown capabilities instead of hiding a supported engine's row", async () => {
    mockListFleetModels.mockResolvedValue(fleet([NO_THINKING_MODEL]));
    renderRow({ model: "gemini-2.5-pro", value: "" });

    // A missing thinking block is not evidence that the model lacks reasoning.
    await waitFor(() => {
      expect(mockListFleetModels).toHaveBeenCalledWith({
        workspace_id: "ws-1",
        execution_group_id: "group-1",
        agent_id: "agent-1",
      });
    });
    expect(await screen.findByText("Reasoning capability unknown")).toBeInTheDocument();
  });

  it("keeps the row when Codex has no group catalog bucket", async () => {
    // No runtime catalog must remain visible as an unknown state.
    renderRow({ provider: "codex", value: "" });

    await waitFor(() => {
      expect(mockListFleetModels).toHaveBeenCalled();
    });
    expect(await screen.findByText("Reasoning capability unknown")).toBeInTheDocument();
  });

  it("preserves reasoning choices for existing agents using automatic scheduling", async () => {
    renderRow({ executionGroupId: null });

    expect(await screen.findByText("Follow runtime default")).toBeInTheDocument();
    expect(mockListFleetModels).toHaveBeenCalledWith({ workspace_id: "ws-1", agent_id: "agent-1" });
  });

  it("uses the bound runtime catalog for a legacy agent without an execution group", async () => {
    renderRow({ executionGroupId: null, runtimeId: "runtime-1" });

    expect(await screen.findByText("Follow runtime default")).toBeInTheDocument();
    expect(mockListFleetModels).toHaveBeenCalledWith({
      workspace_id: "ws-1",
      runtime_id: "runtime-1",
      agent_id: "agent-1",
    });
  });

  it("distinguishes catalog loading and failures from missing capabilities", async () => {
    let reject!: (error: Error) => void;
    mockListFleetModels.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    renderRow({ provider: "codex", model: "gpt-6-astra" });
    expect(await screen.findByText("Loading reasoning options...")).toBeInTheDocument();
    reject(new Error("catalog unavailable"));
    expect(await screen.findByText("Reasoning capability loading failed")).toBeInTheDocument();
  });

  it("shows newly reported Codex efforts after the catalog refreshes", async () => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", online_runtime_count: 1,
      models: [{ id: "gpt-6-astra", label: "Astra" }] }] });
    const { queryClient } = renderRow({ provider: "codex", model: "gpt-6-astra" });
    expect(await screen.findByText("Reasoning capability unknown")).toBeInTheDocument();
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", online_runtime_count: 1,
      models: [{ ...CLAUDE_MODEL, id: "gpt-6-astra", label: "Astra" }] }] });
    await queryClient.invalidateQueries();
    expect(await screen.findByText("Follow runtime default")).toBeInTheDocument();
    expect(screen.queryByText("Reasoning capability unknown")).toBeNull();
  });

  it("renders the row with the persisted raw token when levels are empty but value is set (stale orphan)", async () => {
    // The agent persisted `thinking_level=xhigh` while it was on a
    // thinking-capable model, then was swapped to gemini (or the CLI
    // catalog shrank). PR1's behavior is daemon-side warn/drop, not a
    // synchronous DB clear, so the frontend must surface the orphan
    // token and let the user clear it explicitly.
    mockListFleetModels.mockResolvedValue(fleet([NO_THINKING_MODEL]));
    renderRow({ model: "gemini-2.5-pro", value: "xhigh" });

    await screen.findByText("Reasoning effort");
    // The picker chip carries the raw value when it's not in the catalog.
    expect(await screen.findByText("xhigh")).toBeInTheDocument();
  });

  it("clears the orphan value via the picker footer, emitting onChange(\"\")", async () => {
    mockListFleetModels.mockResolvedValue(fleet([NO_THINKING_MODEL]));
    const { onChange } = renderRow({
      model: "gemini-2.5-pro",
      value: "xhigh",
    });

    // Wait until the row mounts with the orphan value, then open the
    // popover and fire the clear footer. The footer is the only target
    // matching the i18n `thinking_clear_title` copy.
    await screen.findByText("xhigh");
    fireEvent.click(screen.getByRole("button"));
    const clearButton = await screen.findByTitle(/Clear the override/i);
    fireEvent.click(clearButton);

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("disables the picker and explains when the model explicitly supports no levels", async () => {
    mockListFleetModels.mockResolvedValue(fleet([{
      ...NO_THINKING_MODEL,
      thinking: { status: "unsupported", supported_levels: [] },
    }]));
    const { onChange } = renderRow({ model: "gemini-2.5-pro", value: "xhigh" });

    expect(await screen.findByText("Reasoning configuration not supported")).toBeInTheDocument();
    expect(screen.getByText("xhigh")).toBeInTheDocument();
    // No editable empty picker: the only remaining control is "clear".
    const button = screen.getByRole("button");
    expect(button).toHaveAccessibleName(/Clear the override/i);
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("distinguishes an undeclared gateway capability from a failed load", async () => {
    // Gateway-only Claude aliases arrive with no `thinking` block at all: the
    // row must say "unknown", not "loading failed", and must not offer levels.
    mockListFleetModels.mockResolvedValue(fleet([NO_THINKING_MODEL]));
    const { onChange } = renderRow({ model: "gemini-2.5-pro", value: "xhigh" });

    expect(await screen.findByText("Reasoning capability unknown")).toBeInTheDocument();
    expect(screen.queryByText("Reasoning capability loading failed")).toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName(/Clear the override/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hides the clear control but keeps the saved token for read-only viewers", async () => {
    mockListFleetModels.mockResolvedValue(fleet([NO_THINKING_MODEL]));
    renderRow({ model: "gemini-2.5-pro", value: "xhigh", canEdit: false });

    expect(await screen.findByText("xhigh")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the row with the matched label when the model still advertises the value", async () => {
    renderRow({ value: "high" });

    await screen.findByText("Reasoning effort");
    // Both the chip and the tooltip carry "High".
    expect((await screen.findAllByText("High")).length).toBeGreaterThan(0);
  });

  it("renders the runtime-default fallback when value is empty and the model exposes levels", async () => {
    renderRow({ value: "" });

    await screen.findByText("Reasoning effort");
    // Empty value means Multiremi omits the effort override, so the runtime
    // default decides — chip + tooltip both carry the same fallback label.
    expect(
      (await screen.findAllByText("Follow runtime default")).length,
    ).toBeGreaterThan(0);
  });
});
