// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSkills from "../../locales/en/skills.json";

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/api", () => ({ api: {} }));
vi.mock("@multiremi/core/auth", () => {
  const state = { user: { id: "user-1" } };
  return { useAuthStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({ skillDetail: (id: string) => `/skills/${id}` }) }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  skillListOptions: () => ({ queryKey: ["skills"], queryFn: async () => [] }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: async () => [] }),
  memberListOptions: () => ({ queryKey: ["members"], queryFn: async () => [] }),
  selectSkillAssignments: () => new Map(),
}));
vi.mock("@multiremi/core/runtimes", () => ({ runtimeListOptions: () => ({ queryKey: ["runtimes"], queryFn: async () => [] }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock("../../platform", () => ({ openExternal: vi.fn() }));
vi.mock("../../layout/page-header", () => ({ PageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header> }));
vi.mock("./skill-columns", () => ({ useSkillColumns: () => [] }));
vi.mock("./runtime-local-skill-import-panel", () => ({ RuntimeLocalSkillImportPanel: () => <div>Runtime directory importer</div> }));

import SkillsPage from "./skills-page";

describe("Skills page runtime import entry", () => {
  it("opens the runtime importer directly and retains the existing creation chooser", async () => {
    render(<I18nProvider locale="en" resources={{ en: { common: enCommon, skills: enSkills } }}>
      <QueryClientProvider client={new QueryClient()}><SkillsPage /></QueryClientProvider>
    </I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Import from runtime" }));
    expect(await screen.findByText("Runtime directory importer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create manually/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: "New skill" })[0]!);
    expect(await screen.findByRole("button", { name: /Create manually/ })).toBeInTheDocument();
    expect(screen.queryByText("Runtime directory importer")).not.toBeInTheDocument();
  });
});
