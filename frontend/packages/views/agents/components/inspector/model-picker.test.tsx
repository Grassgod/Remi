// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FleetModelsResponse, RuntimeModel } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enAgents from "../../../locales/en/agents.json";
import enIssues from "../../../locales/en/issues.json";

const TEST_RESOURCES = {
  en: { common: enCommon, agents: enAgents, issues: enIssues },
};

const mockListFleetModels = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/api", () => ({
  api: {
    listFleetModels: (...args: unknown[]) => mockListFleetModels(...args),
  },
}));

import { ModelPicker } from "./model-picker";

const CLAUDE_MODEL: RuntimeModel = {
  id: "claude-opus-4-6",
  label: "Claude Opus 4.6",
  default: true,
};

function fleet(models: RuntimeModel[], provider = "claude"): FleetModelsResponse {
  return { providers: [{ provider, online_runtime_count: 2, models }] };
}

function renderPicker(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <ModelPicker
          wsId="ws-1"
          runtimeId=""
          executionGroupId={null}
          agentId="agent-1"
          provider="claude"
          value=""
          canEdit
          onChange={onChange}
          {...props}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...utils, onChange, queryClient };
}

describe("ModelPicker", () => {
  it.each([true, false])("shows an unavailable saved model without changing it (editable %s)", async (canEdit) => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "ready", models: [{ id: "available", label: "Available" }] }] });
    const { onChange } = renderPicker({ provider: "codex", value: "inventory-only", canEdit });
    expect(await screen.findByText("Not in execution catalog · Cannot run")).toBeInTheDocument();
    expect(screen.getByText("inventory-only")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    if (canEdit) {
      fireEvent.click(screen.getByRole("button", { name: "Model · inventory-only" }));
      fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "inventory-only" } });
      expect(screen.queryByText('Use "inventory-only"')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it.each(["error", undefined])("preserves custom model fallback when catalog status is %s", async (model_catalog_status) => {
    mockListFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status, models: [{ id: "inventory-only", label: "Inventory only" }] }] });
    const { onChange } = renderPicker({ provider: "codex", value: "inventory-only" });
    fireEvent.click(screen.getByRole("button", { name: "Model · inventory-only" }));
    expect(await screen.findByText("Inventory only")).toBeInTheDocument();
    expect(screen.queryByText("Not in execution catalog · Cannot run")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "custom-new" } });
    fireEvent.click(screen.getByText('Use "custom-new"'));
    expect(onChange).toHaveBeenCalledWith("custom-new");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFleetModels.mockResolvedValue(fleet([CLAUDE_MODEL]));
  });

  afterEach(() => {
    cleanup();
  });

  // Automatic scheduling stores neither runtime_id nor execution_group_id.
  // The picker used to treat that as "no target" and degrade to static text,
  // leaving the agent stuck on the provider default with no way back.
  it("stays interactive under automatic scheduling and offers the fleet catalog", async () => {
    const { onChange } = renderPicker();

    const trigger = await screen.findByRole("button", { name: "Model · Default" });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(mockListFleetModels).toHaveBeenCalledWith({
        workspace_id: "ws-1",
        agent_id: "agent-1",
      });
    });
    fireEvent.click(await screen.findByText("Claude Opus 4.6"));
    expect(onChange).toHaveBeenCalledWith("claude-opus-4-6");
  });

  it("keeps using the group catalog when an execution group is bound", async () => {
    renderPicker({ executionGroupId: "group-1", value: "claude-opus-4-6" });

    fireEvent.click(await screen.findByRole("button", { name: "Model · claude-opus-4-6" }));
    await waitFor(() => {
      expect(mockListFleetModels).toHaveBeenCalledWith({
        workspace_id: "ws-1",
        execution_group_id: "group-1",
        agent_id: "agent-1",
      });
    });
  });

  it("renders read-only text without an execution target or edit permission", async () => {
    const { rerender } = renderPicker({ provider: "" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Default")).toBeInTheDocument();
    rerender(<div />);

    cleanup();
    renderPicker({ canEdit: false, value: "claude-opus-4-6" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("claude-opus-4-6")).toBeInTheDocument();
  });
});
