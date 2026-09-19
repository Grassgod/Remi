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

function renderDropdown(provider = "codex", value = "inventory-only", fallback = false, excludedModel?: string) {
  const onChange = vi.fn();
  render(
    <I18nProvider locale="en" resources={{ en: { common: enCommon, agents: enAgents } }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ModelDropdown wsId="ws" provider={provider} value={value} onChange={onChange} fallback={fallback} excludedModel={excludedModel} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return onChange;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ModelDropdown execution catalog", () => {
  it("disables the primary model for fallback selection and lets the user clear the fallback", async () => {
    listFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "ready", models: [
      { id: "primary", label: "Primary", execution_status: "available" },
      { id: "other", label: "Other", execution_status: "available" },
    ] }] });
    const onChange = renderDropdown("codex", "other", true, "primary");
    fireEvent.click(screen.getByRole("button", { name: "Fallback model" }));
    expect(await screen.findByRole("button", { name: /Primary/ })).toBeDisabled();
    expect(screen.getByText("Must differ from the primary model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove fallback model" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("does not offer an unlisted fallback against an authoritative non-Codex catalog", async () => {
    listFleetModels.mockResolvedValue({ providers: [{ provider: "claude", model_catalog_status: "ready", models: [
      { id: "known", label: "Known", execution_status: "available" },
      { id: "offline", label: "Offline", execution_status: "unavailable" },
    ] }] });
    const onChange = renderDropdown("claude", "", true);
    fireEvent.click(screen.getByRole("button", { name: "Fallback model" }));
    expect(await screen.findByRole("button", { name: /Known/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Offline/ })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "unlisted" } });
    expect(screen.queryByRole("button", { name: 'Use "unlisted"' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
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

  it("keeps failed inventory visible but disabled while bundled GPT remains selectable", async () => {
    const models = [
      { id: "inventory-only", label: "Inventory only", execution_status: "unavailable" },
      { id: "bundled", label: "Bundled GPT", execution_status: "available" },
    ];
    listFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "error", models }] });
    const onChange = renderDropdown();
    expect(await screen.findByText("Not in execution catalog · Cannot run")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /inventory-only/ }));
    const inventory = await screen.findByRole("button", { name: /Inventory only/ });
    expect(inventory).toBeDisabled();
    fireEvent.click(inventory);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "custom-new" } });
    expect(screen.queryByRole("button", { name: 'Use "custom-new"' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "bundled" } });
    fireEvent.click(screen.getByRole("button", { name: /Bundled GPT/ }));
    expect(onChange).toHaveBeenCalledWith("bundled");
  });

  it("allows a confirmed custom Runtime model while the workspace relay catalog is unknown", async () => {
    listFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "unknown", models: [
      { id: "custom-runtime", label: "Custom Runtime", execution_status: "available" },
      { id: "inventory-only", label: "Inventory only", execution_status: "unknown" },
    ] }] });
    const onChange = renderDropdown("codex", "custom-runtime");
    fireEvent.click(screen.getByRole("button", { name: /custom-runtime/ }));
    const custom = await screen.findByRole("button", { name: /Custom Runtime/ });
    expect(custom).toBeEnabled();
    expect(screen.getByRole("button", { name: /Inventory only/ })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "custom-new" } });
    expect(screen.queryByRole("button", { name: 'Use "custom-new"' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search or type a model ID"), { target: { value: "custom-runtime" } });
    fireEvent.click(screen.getByRole("button", { name: /Custom Runtime/ }));
    expect(onChange).toHaveBeenCalledWith("custom-runtime");
  });

  it("shows unknown execution capability without selecting or replacing the saved model", async () => {
    listFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "unknown", models: [{ id: "inventory-only", label: "Inventory only", execution_status: "unknown" }] }] });
    const onChange = renderDropdown();
    expect(await screen.findByText("Execution capability unknown · Refreshing catalog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /inventory-only/ }));
    expect(await screen.findByRole("button", { name: /Inventory only/ })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["error", undefined])("keeps legacy responses without execution metadata compatible (status %s)", async (model_catalog_status) => {
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
