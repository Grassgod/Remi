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
// model swap landed on a non-thinking provider, or when the fleet catalog
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
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          <ThinkingPropRow
            wsId="ws-1"
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFleetModels.mockResolvedValue(fleet([CLAUDE_MODEL]));
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the row when the active model has no thinking levels and nothing is persisted", async () => {
    mockListFleetModels.mockResolvedValue(fleet([NO_THINKING_MODEL]));
    renderRow({ model: "gemini-2.5-pro", value: "" });

    // ThinkingPropRow returns null when levels are empty and value is
    // empty — both initially (data undefined) and after the fleet catalog
    // resolves (NO_THINKING_MODEL has no `thinking` block).
    await waitFor(() => {
      expect(mockListFleetModels).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText("Thinking")).toBeNull();
    });
  });

  it("hides the row when the engine has no fleet catalog bucket", async () => {
    // A provider with no runtime at all yields no bucket → empty levels,
    // empty value → row stays hidden.
    renderRow({ provider: "codex", value: "" });

    await waitFor(() => {
      expect(mockListFleetModels).toHaveBeenCalled();
    });
    expect(screen.queryByText("Thinking")).toBeNull();
  });

  it("renders the row with the persisted raw token when levels are empty but value is set (stale orphan)", async () => {
    // The agent persisted `thinking_level=xhigh` while it was on a
    // thinking-capable model, then was swapped to gemini (or the CLI
    // catalog shrank). PR1's behavior is daemon-side warn/drop, not a
    // synchronous DB clear, so the frontend must surface the orphan
    // token and let the user clear it explicitly.
    mockListFleetModels.mockResolvedValue(fleet([NO_THINKING_MODEL]));
    renderRow({ model: "gemini-2.5-pro", value: "xhigh" });

    await screen.findByText("Thinking");
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

  it("renders the row with the matched label when the model still advertises the value", async () => {
    renderRow({ value: "high" });

    await screen.findByText("Thinking");
    // Both the chip and the tooltip carry "High".
    expect((await screen.findAllByText("High")).length).toBeGreaterThan(0);
  });

  it("renders the row with \"Follow CLI config\" when value is empty and the model exposes levels", async () => {
    renderRow({ value: "" });

    await screen.findByText("Thinking");
    // Empty value means Multiremi omits --effort, so the local CLI's
    // config decides — chip + tooltip both read "Follow CLI config".
    expect((await screen.findAllByText("Follow CLI config")).length).toBeGreaterThan(0);
  });
});
