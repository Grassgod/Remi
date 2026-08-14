// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent, RuntimeModel } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as "owner" | "admin" | "member" }],
}));
const larkRef = vi.hoisted(() => ({
  current: {
    installations: [] as { agent_id: string; status: string }[],
    configured: true,
    install_supported: true as boolean | undefined,
  },
}));
const modelCatalogRef = vi.hoisted(() => ({
  current: [] as RuntimeModel[],
}));

// Keyed on the query key so the inspector's two integration-visibility
// queries resolve synchronously and independently.
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = JSON.stringify(opts?.queryKey ?? []);
    if (key.includes("lark")) return { data: larkRef.current };
    return { data: membersRef.current };
  },
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/runtimes", () => ({
  useFleetProviderModels: () => ({
    models: modelCatalogRef.current,
    onlineRuntimeCount: 1,
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ upload: vi.fn(), uploading: false }),
}));
vi.mock("@multiremi/core/api", () => ({ api: {} }));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: Object.assign(
    (sel?: (s: { user: { id: string } }) => unknown) =>
      sel ? sel({ user: { id: "user-1" } }) : { user: { id: "user-1" } },
    { getState: () => ({ user: { id: "user-1" } }) },
  ),
}));
vi.mock("@multiremi/core/lark", () => ({
  larkInstallationsOptions: (wsId: string) => ({
    queryKey: ["lark", wsId, "installations"],
  }),
}));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: (wsId: string) => ({ queryKey: ["members", wsId] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <div data-testid="actor-avatar" />,
}));
vi.mock("./inspector/concurrency-picker", () => ({
  ConcurrencyPicker: () => <span>concurrency-picker</span>,
}));
vi.mock("./inspector/engine-picker", () => ({
  EnginePicker: () => <span>engine-picker</span>,
}));
vi.mock("./inspector/model-picker", () => ({
  ModelPicker: ({
    onChange,
  }: {
    onChange: (value: string) => Promise<void> | void;
  }) => (
    <button type="button" onClick={() => void onChange("claude-opus")}>
      switch-model
    </button>
  ),
}));
vi.mock("./inspector/thinking-prop-row", () => ({
  ThinkingPropRow: () => <span>thinking-prop-row</span>,
}));
vi.mock("./inspector/visibility-picker", () => ({
  VisibilityPicker: () => <span>visibility-picker</span>,
}));
vi.mock("./inspector/skill-attach", () => ({
  // Mirrors the real component, which returns null whenever the workspace
  // has no unattached skills to offer.
  SkillAttach: () => null,
}));
vi.mock("../../settings/components/lark-tab", () => ({
  LarkAgentBindButton: () => <button type="button">Bind Lark bot</button>,
}));

import { AgentDetailInspector } from "./agent-detail-inspector";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    runtime_id: "",
    provider: "claude",
    name: "Research Agent",
    description: "Finds evidence",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: [],
    visibility: "workspace",
    status: "idle",
    max_concurrent_tasks: 3,
    model: "claude-sonnet",
    owner_id: "user-1",
    skills: [],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function renderInspector(agent = makeAgent(), canEdit = true) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <AgentDetailInspector
        agent={agent}
        owner={null}
        presence={null}
        canEdit={canEdit}
        onUpdate={onUpdate}
        onShowIntegrations={vi.fn()}
      />
    </I18nProvider>,
  );
  return { onUpdate };
}

beforeEach(() => {
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
  larkRef.current = {
    installations: [],
    configured: true,
    install_supported: true,
  };
  modelCatalogRef.current = [
    {
      id: "claude-sonnet",
      label: "Sonnet",
      default: true,
      thinking: {
        supported_levels: [{ value: "high", label: "High" }],
      },
    },
    {
      id: "claude-opus",
      label: "Opus",
      thinking: {
        supported_levels: [{ value: "low", label: "Low" }],
      },
    },
  ];
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("AgentDetailInspector skills section", () => {
  it("explains the empty state instead of leaving a bare header", () => {
    renderInspector(makeAgent({ skills: [] }));
    expect(screen.getByText("No skills attached yet.")).toBeInTheDocument();
  });

  it("drops the empty-state line once the agent has skills", () => {
    renderInspector(
      makeAgent({
        skills: [{ id: "skill-1", name: "search", description: "" }],
      }),
    );
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.queryByText("No skills attached yet.")).not.toBeInTheDocument();
  });
});

describe("AgentDetailInspector integrations section", () => {
  it("renders the header when an admin can actually bind a bot", () => {
    renderInspector();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bind Lark bot" }),
    ).toBeInTheDocument();
  });

  it("hides the header from an agent owner who is a plain workspace member", () => {
    // LarkAgentBindButton returns null for non owner/admin viewers, so the
    // header would otherwise sit above nothing.
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    renderInspector();
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
  });

  it("hides the header when the deployment cannot complete new installs", () => {
    larkRef.current = {
      installations: [],
      configured: true,
      install_supported: false,
    };
    renderInspector();
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
  });

  it("keeps the header for an already-bound agent even when installs are off", () => {
    larkRef.current = {
      installations: [{ agent_id: "agent-1", status: "active" }],
      configured: true,
      install_supported: false,
    };
    renderInspector();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
  });

  it("hides the header from viewers who cannot edit the agent", () => {
    renderInspector(makeAgent(), false);
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
  });
});

describe("AgentDetailInspector description editor", () => {
  it("opens a described dialog built on the shared textarea", async () => {
    const user = userEvent.setup();
    renderInspector();

    await user.click(screen.getByText("Finds evidence"));

    expect(screen.getByText("Edit description")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Describe what this agent does. Members see it in lists and pickers.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "data-slot",
      "textarea",
    );
  });

  it("marks the field invalid once the draft passes the length limit", async () => {
    const user = userEvent.setup();
    renderInspector();

    await user.click(screen.getByText("Finds evidence"));
    const field = screen.getByRole("textbox");
    expect(field).toHaveAttribute("aria-invalid", "false");

    fireEvent.change(field, { target: { value: "x".repeat(256) } });
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("AgentDetailInspector model editing", () => {
  it("clears an effort that the next model does not support in the same update", () => {
    const { onUpdate } = renderInspector(
      makeAgent({ model: "claude-sonnet", thinking_level: "high" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "switch-model" }));

    expect(onUpdate).toHaveBeenCalledWith("agent-1", {
      model: "claude-opus",
      thinking_level: "",
    });
  });

  it("keeps a compatible effort when changing models", () => {
    const { onUpdate } = renderInspector(
      makeAgent({ model: "claude-sonnet", thinking_level: "low" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "switch-model" }));

    expect(onUpdate).toHaveBeenCalledWith("agent-1", {
      model: "claude-opus",
    });
  });
});
