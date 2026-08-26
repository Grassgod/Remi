// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";

const apiMocks = vi.hoisted(() => ({
  getLatestCliVersion: vi.fn(),
  initiateUpdate: vi.fn(),
  getUpdateResult: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({ api: apiMocks }));

import { MachineCliUpdate, UpdateSection } from "./update-section";

const resources = { en: { common: enCommon, runtimes: enRuntimes } };

function renderWithProviders(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("MachineCliUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getLatestCliVersion.mockResolvedValue("0.3.1");
    apiMocks.initiateUpdate.mockResolvedValue({ id: "update-1" });
    apiMocks.getUpdateResult.mockResolvedValue({
      status: "running",
      output: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a reconciliation state instead of a dash for mixed versions", () => {
    renderWithProviders(
      <MachineCliUpdate
        runtimeId="rt-1"
        currentVersion={null}
        cliVersions={["0.3.0", "0.3.1"]}
        managedByDesktop={false}
      />,
    );

    const control = screen.getByTestId("machine-cli-update");
    expect(control).toHaveTextContent("Versions reconciling");
    expect(control).not.toHaveTextContent("—");
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  });

  it("disables self-update when any provider is Desktop-managed", async () => {
    renderWithProviders(
      <MachineCliUpdate runtimeId="rt-1" currentVersion="0.3.0" cliVersions={["0.3.0"]} managedByDesktop />,
    );

    const managed = await screen.findByRole("button", {
      name: "Managed by Desktop",
    });
    expect(managed).toBeDisabled();
    expect(apiMocks.initiateUpdate).not.toHaveBeenCalled();
  });

  it("keeps failed state within one fixed header row and reveals the full reason", async () => {
    vi.useFakeTimers();
    const fullError =
      "CLI update blocked: providers are busy: codex (2 active tasks); retry when all providers are idle";
    apiMocks.getUpdateResult.mockResolvedValue({
      status: "failed",
      output: null,
      error: fullError,
    });

    renderWithProviders(
      <MachineCliUpdate runtimeId="rt-1" currentVersion="0.3.0" cliVersions={["0.3.0"]} managedByDesktop={false} />,
    );

    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () => Promise.resolve());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const control = screen.getByTestId("machine-cli-update");
    // Single-line and floor-width, but not a hard width: a fixed w-48 clipped
    // the action off the right edge once version strings grew.
    expect(control).toHaveClass("h-6", "min-w-48", "overflow-hidden");
    expect(control).not.toHaveClass("w-48");
    expect(control).not.toHaveTextContent(fullError);

    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Update failed" }));
    await waitFor(() => expect(screen.getByText(fullError)).toBeInTheDocument());
  });

  it("disables an available update when the machine has no online representative", async () => {
    renderWithProviders(
      <MachineCliUpdate runtimeId={null} currentVersion="0.3.0" cliVersions={["0.3.0"]} managedByDesktop={false} />,
    );

    expect(await screen.findByRole("button", { name: "Update" })).toBeDisabled();
  });
});

describe("UpdateSection", () => {
  it("only renders provider-scoped Agent and ACP update actions", () => {
    renderWithProviders(<UpdateSection runtimeId="rt-1" agentVersion="1.2.3" acpVersion="2.3.4" isOnline />);

    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update ACP" })).toBeInTheDocument();
  });
});
