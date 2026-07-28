// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Agent } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/runtimes", () => ({
  useFleetProviderModels: (_wsId: string, provider: string) => ({
    models:
      provider === "claude"
        ? [
            {
              id: "claude-sonnet",
              name: "Sonnet",
              default: true,
              thinking: {
                supported_levels: [
                  { value: "low", label: "Low", description: "" },
                  { value: "high", label: "High", description: "" },
                ],
              },
            },
          ]
        : [],
    onlineRuntimeCount: 1,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("../../runtimes/components/provider-logo", () => ({
  ProviderLogo: () => null,
}));

vi.mock("./avatar-picker", () => ({
  AvatarPicker: () => <div data-testid="avatar-picker" />,
}));

vi.mock("./model-dropdown", () => ({
  ModelDropdown: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="Model"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("./instructions-editor", () => ({
  InstructionsEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Instructions"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("./inspector/thinking-picker", () => ({
  ThinkingPicker: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label="Thinking"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Follow CLI config</option>
      <option value="low">Low</option>
      <option value="high">High</option>
    </select>
  ),
}));

import { EditAgentDialog } from "./edit-agent-dialog";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    runtime_id: "",
    provider: "claude",
    name: "Research Agent",
    description: "Finds evidence",
    instructions: "Use primary sources",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: [],
    visibility: "workspace",
    status: "idle",
    max_concurrent_tasks: 3,
    model: "claude-sonnet",
    thinking_level: "low",
    owner_id: "user-1",
    skills: [],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function renderDialog(agent = makeAgent()) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <EditAgentDialog agent={agent} onClose={onClose} onSave={onSave} />
    </I18nProvider>,
  );
  return { onSave, onClose };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("EditAgentDialog", () => {
  it("submits the editable platform metadata in one update", async () => {
    const { onSave, onClose } = renderDialog();

    fireEvent.change(screen.getByDisplayValue("Research Agent"), {
      target: { value: "Research Lead" },
    });
    fireEvent.change(screen.getByDisplayValue("Finds evidence"), {
      target: { value: "Finds and verifies evidence" },
    });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-opus" },
    });
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByLabelText("Thinking"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Verify every claim" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /^Personal / }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      name: "Research Lead",
      description: "Finds and verifies evidence",
      avatar_url: "",
      provider: "claude",
      model: "claude-opus",
      thinking_level: "high",
      visibility: "private",
      max_concurrent_tasks: 6,
      instructions: "Verify every claim",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears engine-specific model and thinking settings on engine switch", async () => {
    const { onSave } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      provider: "codex",
      model: "",
      thinking_level: "",
    });
  });

  it("rejects an empty name and out-of-range concurrency locally", () => {
    renderDialog();
    const save = screen.getByRole("button", { name: "Save changes" });
    const nameInput = screen.getByDisplayValue("Research Agent");

    fireEvent.change(nameInput, {
      target: { value: " " },
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(nameInput, {
      target: { value: "Research Agent" },
    });
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "51" },
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Max concurrent tasks/)).not.toBeNull();
  });
});
