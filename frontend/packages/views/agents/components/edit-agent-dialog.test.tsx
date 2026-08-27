// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Agent,
  RuntimeModelThinkingLevel,
} from "@multiremi/core/types";
import type { SupportedLocale } from "@multiremi/core/i18n";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
import zhCommon from "../../locales/zh-Hans/common.json";
import zhAgents from "../../locales/zh-Hans/agents.json";

const TEST_RESOURCES = {
  en: { common: enCommon, agents: enAgents },
  "zh-Hans": { common: zhCommon, agents: zhAgents },
};

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
              label: "Sonnet",
              default: true,
              thinking: {
                supported_levels: [
                  { value: "low", label: "Low", description: "" },
                  { value: "high", label: "High", description: "" },
                ],
              },
            },
            {
              id: "claude-opus",
              label: "Opus",
              thinking: {
                supported_levels: [
                  { value: "high", label: "High", description: "" },
                ],
              },
            },
            {
              id: "claude-haiku",
              label: "Haiku",
              thinking: {
                supported_levels: [
                  { value: "low", label: "Low", description: "" },
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
    levels,
    onChange,
  }: {
    value: string;
    levels: RuntimeModelThinkingLevel[];
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label="Reasoning effort"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Follow runtime default</option>
      {levels.map((level) => (
        <option key={level.value} value={level.value}>
          {level.label}
        </option>
      ))}
      {value && !levels.some((level) => level.value === value) && (
        <option value={value}>{value}</option>
      )}
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

function renderDialog(
  agent = makeAgent(),
  locale: SupportedLocale = "en",
  canManageRole = false,
) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <I18nProvider locale={locale} resources={TEST_RESOURCES}>
      <EditAgentDialog
        agent={agent}
        canManageRole={canManageRole}
        onClose={onClose}
        onSave={onSave}
      />
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
    fireEvent.change(screen.getByRole("combobox", { name: "Reasoning effort" }), {
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

  it("lets workspace admins update the permission role", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog(makeAgent({ role: "normal" }), "en", true);

    await user.click(screen.getByRole("combobox", { name: "Permission role" }));
    await user.click(await screen.findByRole("option", { name: "Maintainer" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ role: "maintainer" });
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

  it("clears an effort that the newly selected model does not support", async () => {
    const { onSave } = renderDialog();

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-opus" },
    });
    expect(
      (screen.getByRole("combobox", {
        name: "Reasoning effort",
      }) as HTMLSelectElement).value,
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-opus",
      thinking_level: "",
    });
  });

  it("keeps an effort that the newly selected model still supports", async () => {
    const { onSave } = renderDialog();

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-haiku" },
    });
    expect(
      (screen.getByRole("combobox", {
        name: "Reasoning effort",
      }) as HTMLSelectElement).value,
    ).toBe("low");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-haiku",
      thinking_level: "low",
    });
  });

  it("surfaces an orphan effort until the user explicitly clears it", async () => {
    const { onSave } = renderDialog(
      makeAgent({ model: "claude-retired", thinking_level: "xhigh" }),
    );

    const effort = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect((effort as HTMLSelectElement).value).toBe("xhigh");
    fireEvent.change(effort, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].thinking_level).toBe("");
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

  it("associates every field label with its control", () => {
    renderDialog();

    // getByLabelText resolves through htmlFor/id (text inputs) and through
    // role=group + aria-labelledby (the button groups), so an unlabelled
    // control fails this test instead of silently shipping.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Research Agent",
    );
    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).value,
    ).toBe("Finds evidence");
    expect(
      (screen.getByLabelText("Concurrency") as HTMLInputElement).value,
    ).toBe("3");
    expect(screen.getByRole("group", { name: "Visibility" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "Engine" })).not.toBeNull();
    expect(
      screen.getByRole("group", { name: "Reasoning effort" }),
    ).not.toBeNull();
  });

  it("renders the actions inside the shared dialog footer", () => {
    renderDialog();

    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    // Both actions live in the footer, so they pick up its responsive
    // flex-col-reverse → sm:flex-row stacking instead of staying side by
    // side on a narrow viewport.
    expect(
      footer?.contains(screen.getByRole("button", { name: "Cancel" })),
    ).toBe(true);
    expect(
      footer?.contains(screen.getByRole("button", { name: "Save changes" })),
    ).toBe(true);
  });

  it("translates the visibility options instead of hardcoding English", () => {
    renderDialog(makeAgent(), "zh-Hans");

    expect(screen.getByText("工作区")).not.toBeNull();
    expect(screen.getByText("工作区内所有成员都可以指派")).not.toBeNull();
    expect(screen.getByText("个人")).not.toBeNull();
    expect(screen.getByText("仅你和工作区管理员可以指派")).not.toBeNull();
    expect(screen.queryByText("All members can assign")).toBeNull();
  });
});
