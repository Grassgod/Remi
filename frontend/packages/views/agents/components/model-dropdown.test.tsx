// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const listFleetModels = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({ api: { listFleetModels } }));
import { ModelDropdown } from "./model-dropdown";

function renderDropdown(provider = "codex", value = "inventory-only") {
  const onChange = vi.fn();
  render(
    <I18nProvider locale="en" resources={{ en: { common: enCommon, agents: enAgents } }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ModelDropdown wsId="ws" provider={provider} value={value} onChange={onChange} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return onChange;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ModelDropdown execution catalog", () => {
  it("retains an absent saved model as unavailable and never offers it as a custom option", async () => {
    listFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "ready", models: [{ id: "available", label: "Available" }] }] });
    const onChange = renderDropdown();
    expect(await screen.findByText("Not in execution catalog · Cannot run")).toBeInTheDocument();
    expect(screen.getByText("inventory-only")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /inventory-only/ }));
    expect(await screen.findByRole("button", { name: /Available/ })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "inventory-only" } });
    expect(screen.queryByRole("button", { name: 'Use "inventory-only"' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "available" } });
    fireEvent.click(screen.getByRole("button", { name: /Available/ }));
    expect(onChange).toHaveBeenCalledWith("available");
  });

  it.each(["error", undefined])("keeps fallback models and custom selection with status %s", async (model_catalog_status) => {
    listFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status, models: [{ id: "inventory-only", label: "Inventory only" }] }] });
    const onChange = renderDropdown();
    fireEvent.click(screen.getByRole("button", { name: /inventory-only/ }));
    expect(await screen.findByRole("button", { name: /Inventory only/ })).toBeInTheDocument();
    expect(screen.queryByText("Not in execution catalog · Cannot run")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "custom-new" } });
    fireEvent.click(screen.getByRole("button", { name: 'Use "custom-new"' }));
    expect(onChange).toHaveBeenCalledWith("custom-new");
  });

  it("does not restrict Claude custom models", async () => {
    listFleetModels.mockResolvedValue({ providers: [{ provider: "claude", models: [] }] });
    const onChange = renderDropdown("claude");
    fireEvent.click(screen.getByRole("button", { name: /inventory-only/ }));
    fireEvent.change(await screen.findByPlaceholderText("Search or type a model ID"), { target: { value: "custom-claude" } });
    fireEvent.click(screen.getByRole("button", { name: 'Use "custom-claude"' }));
    expect(onChange).toHaveBeenCalledWith("custom-claude");
  });
});
