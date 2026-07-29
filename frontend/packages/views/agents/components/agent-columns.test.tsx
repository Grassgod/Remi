// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Agent } from "@multiremi/core/types";
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

// Tooltip content only mounts on hover in the real primitive; render it
// inline so the copy is assertable (same approach as create-project.test).
vi.mock("@multiremi/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <div data-testid="actor-avatar" />,
}));

import { createAgentColumns, type AgentRow } from "./agent-columns";
import { useT } from "../../i18n";

function makeRow(overrides: Partial<Agent> = {}): AgentRow {
  return {
    agent: {
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
      visibility: "private",
      status: "idle",
      max_concurrent_tasks: 3,
      model: "",
      owner_id: "user-1",
      skills: [],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      archived_at: null,
      archived_by: null,
      ...overrides,
    },
    runtime: null,
    presence: null,
    activity: null,
    runCount: 0,
    ownerIdToShow: null,
    isOwnedByMe: false,
    canManage: true,
  };
}

// The name cell is a column-definition renderer, so drive it through the
// same factory the table uses instead of reaching for the private component.
function AgentNameCellHarness({ row }: { row: AgentRow }) {
  const { t } = useT("agents");
  const columns = createAgentColumns({
    onDuplicate: vi.fn(),
    onEdit: vi.fn(),
    t,
  });
  const column = columns.find((c) => c.id === "agent");
  if (!column?.cell || typeof column.cell !== "function") {
    throw new Error("agent column has no cell renderer");
  }
  const cell = column.cell as (ctx: {
    row: { original: AgentRow };
  }) => ReactNode;
  return <>{cell({ row: { original: row } })}</>;
}

function renderCell(row: AgentRow, locale: SupportedLocale = "en") {
  return render(
    <I18nProvider locale={locale} resources={TEST_RESOURCES}>
      <AgentNameCellHarness row={row} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("agent name cell visibility tooltip", () => {
  it("uses the translated visibility copy for private agents", () => {
    renderCell(makeRow(), "zh-Hans");

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "个人 · 仅你和工作区管理员可以使用该智能体",
    );
  });

  it("renders the English copy from the locale bundle", () => {
    renderCell(makeRow());

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Personal · only you and workspace admins can use this agent",
    );
  });

  it("shows no visibility tooltip for workspace agents", () => {
    renderCell(makeRow({ visibility: "workspace" }));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
