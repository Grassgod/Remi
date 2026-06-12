import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRuntime } from "@multimira/core/types";
import { I18nProvider } from "@multimira/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enOnboarding from "../../locales/en/onboarding.json";

const TEST_RESOURCES = { en: { common: enCommon, onboarding: enOnboarding } };

const mocks = vi.hoisted(() => ({
  pickerState: {
    runtimes: [] as AgentRuntime[],
    selected: null as AgentRuntime | null,
    selectedId: null as string | null,
    setSelectedId: vi.fn<(id: string) => void>(),
    hasRuntimes: false,
  },
}));

// Swap out the runtime picker so tests can drive runtimes / selection
// without a real TanStack Query + WS stack.
vi.mock("../components/use-runtime-picker", () => ({
  useRuntimePicker: () => mocks.pickerState,
}));

import { StepPlatformFork } from "./step-platform-fork";

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "rt_test",
    workspace_id: "ws_test",
    name: "Claude Code",
    provider: "claude",
    status: "online",
    runtime_mode: "local",
    runtime_config: {},
    device_info: "",
    metadata: {},
    daemon_id: null,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as AgentRuntime;
}

function renderFork(
  overrides: Partial<React.ComponentProps<typeof StepPlatformFork>> = {},
) {
  const onNext = vi.fn();
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <StepPlatformFork
        wsId="ws_test"
        onNext={onNext}
        cliInstructions={<div data-testid="cli-instructions">install me</div>}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { onNext };
}

function resetPicker(patch: Partial<typeof mocks.pickerState> = {}) {
  mocks.pickerState.runtimes = patch.runtimes ?? [];
  mocks.pickerState.selected = patch.selected ?? null;
  mocks.pickerState.selectedId = patch.selectedId ?? null;
  mocks.pickerState.hasRuntimes = patch.hasRuntimes ?? false;
  mocks.pickerState.setSelectedId = vi.fn();
}

describe("StepPlatformFork", () => {
  beforeEach(() => {
    resetPicker();
    vi.restoreAllMocks();
  });

  it("renders only the CLI connect card (self-host: no desktop/cloud)", () => {
    renderFork();
    expect(screen.getByText(/^connect from the terminal$/i)).toBeInTheDocument();
    // Desktop-download and cloud cards were removed for the web-only build.
    expect(screen.queryByText(/^use this computer$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^use a cloud computer$/i)).not.toBeInTheDocument();
    // CLI dialog closed at rest → no CLI instructions.
    expect(screen.queryByTestId("cli-instructions")).not.toBeInTheDocument();
  });

  it("footer: Skip only + explanatory hint (no Continue)", () => {
    renderFork();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeEnabled();
    // Continue is gone — it lived in the footer before; now advancement
    // for the CLI path is owned by the CLI dialog's own button.
    expect(
      screen.queryByRole("button", { name: /^continue$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/pick a way to connect — or skip and connect a computer later/i),
    ).toBeInTheDocument();
  });

  it("Skip is always enabled and calls onNext(null)", async () => {
    const user = userEvent.setup();
    const { onNext } = renderFork();
    await user.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith(null);
  });

  it("CLI dialog: opens with instructions + 'waiting' and a disabled Connect button", async () => {
    const user = userEvent.setup();
    renderFork();

    await user.click(screen.getByRole("button", { name: /show steps/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("cli-instructions")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/waiting for your computer/i),
    ).toBeInTheDocument();
    // Start exploring stays disabled while no runtime is selected.
    expect(
      within(dialog).getByRole("button", { name: /start exploring/i }),
    ).toBeDisabled();
  });

  it("CLI dialog with a selected runtime: Connect enables and fires onNext(runtime)", async () => {
    const rt = makeRuntime({ id: "rt_claude", name: "Claude Code" });
    resetPicker({
      runtimes: [rt],
      selected: rt,
      selectedId: rt.id,
      hasRuntimes: true,
    });
    const user = userEvent.setup();
    const { onNext } = renderFork();

    await user.click(screen.getByRole("button", { name: /show steps/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1 computer connected/i)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/selected: claude code/i),
    ).toBeInTheDocument();

    const connect = within(dialog).getByRole("button", {
      name: /start exploring/i,
    });
    expect(connect).toBeEnabled();
    await user.click(connect);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith(rt);
  });

});
