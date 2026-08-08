// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const fleet = vi.hoisted(() => ({ onlineRuntimeCount: 1, isLoading: false }));
vi.mock("@multiremi/core/runtimes", () => ({
  useFleetProviderModels: () => ({
    models: [],
    isError: false,
    ...fleet,
  }),
}));

vi.mock("../../runtimes/components/provider-logo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => (
    <span data-testid={`logo-${provider}`} />
  ),
}));

import { ENGINES, EngineSelect } from "./engine-select";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

function renderWithI18n(node: ReactNode) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {node}
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  fleet.onlineRuntimeCount = 1;
  fleet.isLoading = false;
});

describe("EngineSelect", () => {
  it("renders one button per engine and marks the selected one", () => {
    renderWithI18n(
      <EngineSelect wsId="ws-1" value="claude" onChange={vi.fn()} />
    );

    for (const engine of ENGINES) {
      expect(screen.getByRole("button", { name: engine })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "claude" }).className
    ).toContain("border-primary");
    expect(screen.getByRole("button", { name: "codex" }).className).toContain(
      "border-border"
    );
  });

  it("labels the button pair as a group for assistive tech", () => {
    const { container } = renderWithI18n(
      <EngineSelect wsId="ws-1" value="claude" onChange={vi.fn()} />
    );

    const group = container.querySelector('[role="group"]');
    const labelId = group?.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(labelId!)}`)).toBeTruthy();
  });

  it("reports a real engine change so callers can reset their model state", () => {
    const onChange = vi.fn();
    renderWithI18n(
      <EngineSelect wsId="ws-1" value="claude" onChange={onChange} />
    );

    fireEvent.click(screen.getByRole("button", { name: "codex" }));
    expect(onChange).toHaveBeenCalledWith("codex");
  });

  it("stays silent when the already-selected engine is clicked", () => {
    const onChange = vi.fn();
    renderWithI18n(
      <EngineSelect wsId="ws-1" value="claude" onChange={onChange} />
    );

    fireEvent.click(screen.getByRole("button", { name: "claude" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("warns when the chosen engine has no online capacity", () => {
    fleet.onlineRuntimeCount = 0;
    renderWithI18n(
      <EngineSelect wsId="ws-1" value="codex" onChange={vi.fn()} />
    );

    expect(
      screen.getByText(enAgents.create_dialog.engine_no_capacity)
    ).toBeInTheDocument();
  });

  it("holds the warning back until the fleet query has answered", () => {
    fleet.onlineRuntimeCount = 0;
    fleet.isLoading = true;
    renderWithI18n(
      <EngineSelect wsId="ws-1" value="codex" onChange={vi.fn()} />
    );

    expect(
      screen.queryByText(enAgents.create_dialog.engine_no_capacity)
    ).not.toBeInTheDocument();
  });
});
