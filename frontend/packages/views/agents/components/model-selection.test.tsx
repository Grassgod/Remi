import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enAgents from "../../locales/en/agents.json";
import { ModelDropdown } from "./model-dropdown";
import { ModelPicker } from "./inspector/model-picker";

const listFleetModels = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({ api: { listFleetModels } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSelection(component: React.ReactNode) {
  listFleetModels.mockResolvedValue({ providers: [{
    provider: "codex", online_runtime_count: 1,
    models: [{ id: "supported-model", label: "Supported model", default: true }],
  }] });
  return render(
    <I18nProvider locale="en" resources={{ en: { agents: enAgents } }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {component}
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe.each([ModelDropdown, ModelPicker])("$name model selection", (Component) => {
  it.each([
    { name: "model routing", target: {}, query: {} },
    { name: "group", target: { executionGroupId: "group-1" }, query: { execution_group_id: "group-1" } },
    { name: "legacy runtime", target: { runtimeId: "runtime-1" }, query: { runtime_id: "runtime-1" } },
  ])("selects a supported model for $name scheduling", async ({ target, query }) => {
    const onChange = vi.fn();
    renderSelection(<Component wsId="ws-1" provider="codex" agentId="agent-1" value="" onChange={onChange} {...target} />);

    const trigger = screen.getByRole("button");
    expect(trigger).toBeEnabled();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /Supported model/ }));

    expect(onChange).toHaveBeenCalledWith("supported-model");
    expect(listFleetModels).toHaveBeenCalledWith({ workspace_id: "ws-1", agent_id: "agent-1", ...query });
  });
});

it("keeps the model routing model read-only when editing is forbidden", () => {
  renderSelection(<ModelPicker wsId="ws-1" provider="codex" value="supported-model" canEdit={false} onChange={vi.fn()} />);
  expect(screen.getByText("supported-model")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
