import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import { agentRunCountsKeys } from "@multiremi/core/agents";
import type { MemberWithUser } from "@multiremi/core/types";
import enCommon from "../locales/en/common.json";
import enMembers from "../locales/en/members.json";
import { MemberProfileCard } from "./member-profile-card";
import { MemberDetailPage } from "./member-detail-page";

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/api", () => ({
  api: {
    listMembers: () => new Promise(() => {}),
    listAgents: () => new Promise(() => {}),
    getWorkspaceAgentRunCounts: () => new Promise(() => {}),
    getBaseUrl: () => "https://remi.example.test",
  },
}));
vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1", name: "Remi", slug: "remi", avatar_url: null }),
  useWorkspacePaths: () => ({ agentDetail: (id: string) => `/remi/agents/${id}` }),
}));
vi.mock("../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../common/actor-issues-panel", () => ({ ActorIssuesPanel: () => <div>Member issues</div> }));
vi.mock("../navigation", () => ({
  AppLink: ({ href, children }: React.ComponentProps<"a">) => <a href={href}>{children}</a>,
}));

const member: MemberWithUser = {
  id: "mem_member",
  workspace_id: "ws-1",
  user_id: "usr_member",
  name: "测试用户",
  role: "owner",
  avatar_url: null,
  created_at: "2026-10-08T00:00:00Z",
};

function renderMember(component: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(workspaceKeys.members("ws-1"), [member]);
  qc.setQueryData(workspaceKeys.agents("ws-1"), [
    { id: "agt_owned", name: "Owned agent", owner_id: member.user_id, archived_at: null },
    { id: "agt_other", name: "Other agent", owner_id: "usr_other", archived_at: null },
  ]);
  qc.setQueryData(agentRunCountsKeys.last30d("ws-1"), []);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider resources={{ en: { common: enCommon, members: enMembers } }} locale="en">
        {component}
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("member profile identity", () => {
  it.each([member.id, member.user_id])("shows the profile and owned agents for identity %s", (id) => {
    renderMember(<MemberProfileCard userId={id} />);

    expect(screen.getByText("测试用户")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Owned agent/ })).toHaveAttribute("href", "/remi/agents/agt_owned");
    expect(screen.queryByText("Other agent")).not.toBeInTheDocument();
  });

  it.each([member.id, member.user_id])("opens the member detail for identity %s", (id) => {
    renderMember(<MemberDetailPage userId={id} />);

    expect(screen.getByRole("heading", { name: "测试用户" })).toBeInTheDocument();
    expect(screen.getByText("Member issues")).toBeInTheDocument();
    expect(screen.queryByText("Member not found")).not.toBeInTheDocument();
  });

  it("keeps the unavailable state for an unknown identity", () => {
    renderMember(<MemberProfileCard userId="missing" />);
    expect(screen.getByText("Member unavailable")).toBeInTheDocument();
  });
});
