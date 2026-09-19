// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

vi.mock("./execution-target-select", () => ({
  ExecutionTargetSelect: ({ onChange }: { onChange: (target: { executionGroupId: string; provider: string }) => void }) => (
    <div role="group" aria-label="Execution target">{["claude", "codex"].map((provider) => <button key={provider} onClick={() => onChange({ executionGroupId: `group-${provider}`, provider })}>{provider}</button>)}</div>
  ),
}));

const TEST_RESOURCES = {
  en: { common: enCommon, agents: enAgents },
  "zh-Hans": { common: zhCommon, agents: zhAgents },
};

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const catalog = vi.hoisted(() => ({ status: "ready", models: [] as Array<{ id: string; label: string; execution_status: string }> }));

vi.mock("@multiremi/core/runtimes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/runtimes")>(),
  useExecutionTargetModels: (_wsId: string, provider: string) => ({
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
            {
              // Capability load failed for this model: the thinking block
              // carries an explicit error instead of an empty level set.
              id: "claude-flaky",
              label: "Flaky",
              thinking: { status: "error", supported_levels: [] },
            },
          ]
        : catalog.models,
    modelCatalogStatus: provider === "codex" ? catalog.status : undefined,
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
    fallback,
  }: {
    value: string;
    onChange: (value: string) => void;
    fallback?: boolean;
  }) => (
    <input
      aria-label={fallback ? "Fallback model" : "Model"}
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
  catalog.status = "ready";
  catalog.models = [];
  cleanup();
  document.body.innerHTML = "";
});

describe("EditAgentDialog", () => {
  it.each(["unknown", "error"])("allows only unrelated edits when the saved execution capability is %s", async (status) => {
    catalog.status = status;
    catalog.models = [{ id: "inventory-only", label: "Inventory only", execution_status: status === "unknown" ? "unknown" : "unavailable" }];
    const { onSave } = renderDialog(makeAgent({ provider: "codex", model: "inventory-only", thinking_level: "saved-effort" }));
    expect(screen.getByText(status === "unknown" ? "Execution capability unknown · Refreshing catalog" : "Not in execution catalog · Cannot run")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ description: "Updated description", model: "inventory-only", thinking_level: "saved-effort" });
  });

  it("blocks execution edits while the catalog is unknown", () => {
    catalog.status = "unknown";
    const { onSave } = renderDialog(makeAgent({ provider: "codex", model: "inventory-only", thinking_level: "" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "other-route" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps an unavailable saved model and reasoning unchanged during an unrelated save", async () => {
    const { onSave } = renderDialog(makeAgent({ provider: "codex", model: "inventory-only", thinking_level: "saved-effort" }));
    expect(screen.getByText("Not in execution catalog · Cannot run")).toBeInTheDocument();
    expect(screen.queryByText("Reasoning capability unknown")).toBeNull();
    expect(screen.getByLabelText("Model")).toHaveValue("inventory-only");
    // The model declares no levels, so the draft's effort renders read-only
    // instead of as an editable picker. The unexecutable model is not editable
    // here, so no clear control is offered either.
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    expect(screen.getByText("saved-effort")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear the override/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ description: "Updated description", model: "inventory-only", thinking_level: "saved-effort" });
  });

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

  it("sends the current group again when explicitly releasing a migrated machine pin", async () => {
    const { onSave } = renderDialog(makeAgent({ runtime_id: "old-machine", execution_group_id: "group-claude" }));
    fireEvent.click(screen.getByRole("button", { name: "claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ execution_group_id: "group-claude", provider: "claude" });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("runtime_id");
  });

  it("clears target-specific model and thinking settings when changing targets", async () => {
    const { onSave } = renderDialog(makeAgent({ fallback_model: "claude-opus", fallback_thinking_level: "high" }));

    fireEvent.click(screen.getByRole("button", { name: "codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      provider: "codex",
      execution_group_id: "group-codex",
      model: "",
      thinking_level: "",
      fallback_model: "",
      fallback_thinking_level: "",
    });
  });

  it("persists fallback selection and explicit clearing without changing unrelated fields", async () => {
    const { onSave } = renderDialog();
    fireEvent.change(screen.getByLabelText("Fallback model"), { target: { value: "claude-opus" } });
    expect(screen.getByRole("group", { name: "Fallback reasoning effort" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fallback_model: "claude-opus" })));
  });

  it("clears the saved fallback and effort, and prevents choosing the primary", async () => {
    const { onSave } = renderDialog(makeAgent({ fallback_model: "claude-opus", fallback_thinking_level: "high" }));
    fireEvent.change(screen.getByLabelText("Fallback model"), { target: { value: "claude-sonnet" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Fallback model"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fallback_model: "", fallback_thinking_level: "" })));
  });

  it("preserves a saved unavailable fallback on unrelated edits", async () => {
    catalog.models = [{ id: "old", label: "Old", execution_status: "unavailable" }];
    const { onSave } = renderDialog(makeAgent({ provider: "codex", model: "", thinking_level: "", fallback_model: "old" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ description: "Updated" })));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("fallback_model");
  });

  it("blocks a newly selected unavailable fallback", () => {
    catalog.models = [{ id: "old", label: "Old", execution_status: "unavailable" }];
    const { onSave } = renderDialog(makeAgent({ provider: "codex", model: "", thinking_level: "" }));
    fireEvent.change(screen.getByLabelText("Fallback model"), { target: { value: "old" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
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

  it("shows an orphan effort read-only until the user explicitly clears it", async () => {
    const { onSave } = renderDialog(
      makeAgent({ model: "claude-retired", thinking_level: "xhigh" }),
    );

    // A model that declares no levels gets a read-only value plus an explicit
    // clear control, not an empty editable picker.
    expect(screen.getByText("xhigh")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Clear the override/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].thinking_level).toBe("");
  });

  it("keeps the editable picker when the model's capability load failed", () => {
    // A failed load is not an authoritative "no levels" verdict, so the saved
    // effort stays editable (and clearable) exactly as before.
    renderDialog(makeAgent({ provider: "claude", model: "claude-flaky", thinking_level: "high" }));

    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveValue("high");
    expect(screen.getByText("Reasoning capability loading failed")).toBeInTheDocument();
  });

  it("keeps the editable picker when the model declares reasoning levels", () => {
    renderDialog(makeAgent({ provider: "claude", model: "claude-opus", thinking_level: "high" }));

    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveValue("high");
    expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
  });

  it("shows a level-less fallback effort read-only and clears it", async () => {
    const { onSave } = renderDialog(makeAgent({
      provider: "claude",
      model: "claude-sonnet",
      thinking_level: "low",
      fallback_model: "claude-retired",
      fallback_thinking_level: "xhigh",
    }));

    const fallbackGroup = screen.getByRole("group", { name: "Fallback reasoning effort" });
    expect(within(fallbackGroup).getByText("xhigh")).toBeInTheDocument();
    expect(fallbackGroup.querySelector("select")).toBeNull();
    fireEvent.click(within(fallbackGroup).getByRole("button", { name: /Clear the override/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // The fallback model itself is unchanged, so only the cleared effort ships.
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ fallback_thinking_level: "" });
    expect(onSave.mock.calls[0]?.[0].fallback_model).toBeUndefined();
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
    expect(screen.getByRole("group", { name: "Execution target" })).not.toBeNull();
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
