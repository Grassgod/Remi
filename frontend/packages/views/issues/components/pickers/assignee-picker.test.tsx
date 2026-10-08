import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import type { MemberWithUser } from "@multiremi/core/types";
import enCommon from "../../../locales/en/common.json";
import enIssues from "../../../locales/en/issues.json";
import { AssigneePicker } from "./assignee-picker";

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "usr_member" } }),
    { getState: () => ({ user: { id: "usr_member" } }) },
  ),
}));
vi.mock("@multiremi/core/platform/use-after-first-screen", () => ({ useAfterFirstScreen: () => false }));
vi.mock("@multiremi/core/api", () => ({
  api: {
    listMembers: () => new Promise(() => {}),
    listAgents: () => new Promise(() => {}),
    listSquads: () => new Promise(() => {}),
    getAssigneeFrequency: () => new Promise(() => {}),
    getBaseUrl: () => "https://remi.example.test",
  },
}));
vi.mock("../../../navigation", () => ({
  useNavigation: () => ({ pathname: "/test/issues/issue-1" }),
}));
vi.mock("../../../common/actor-avatar", () => ({ ActorAvatar: () => null }));

const member: MemberWithUser = {
  id: "mem_member",
  workspace_id: "ws-1",
  user_id: "usr_member",
  name: "测试用户",
  role: "owner",
  avatar_url: null,
  created_at: "2026-10-08T00:00:00Z",
};

function renderPicker(assigneeId: string | null, members = [member], frequency: Array<{ assignee_type: string; assignee_id: string; frequency: number }> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(workspaceKeys.members("ws-1"), members);
  qc.setQueryData(workspaceKeys.agents("ws-1"), []);
  qc.setQueryData(workspaceKeys.squads("ws-1"), []);
  qc.setQueryData(workspaceKeys.assigneeFrequency("ws-1"), frequency);
  const onUpdate = vi.fn();
  const wrap = (id: string | null) => (
    <QueryClientProvider client={qc}>
      <I18nProvider resources={{ en: { common: enCommon, issues: enIssues } }} locale="en">
        <AssigneePicker assigneeType={id ? "member" : null} assigneeId={id} onUpdate={onUpdate} />
      </I18nProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(assigneeId));
  return { onUpdate, ...result, rerenderAssignee: (id: string) => result.rerender(wrap(id)) };
}

async function findMemberOption(name: string) {
  return waitFor(() => {
    const button = screen.getAllByRole("button", { name })
      .find((button) => button.hasAttribute("data-picker-item"));
    expect(button).toBeDefined();
    return button!;
  });
}

describe("AssigneePicker member identity", () => {
  it("submits the member row id and keeps the saved member visible and selected", async () => {
    const { onUpdate, rerenderAssignee } = renderPicker(null);
    fireEvent.click(screen.getByRole("button", { name: "Unassigned" }));
    fireEvent.click(await findMemberOption("测试用户"));
    expect(onUpdate).toHaveBeenCalledWith({ assignee_type: "member", assignee_id: member.id });

    rerenderAssignee(member.id);
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "测试用户" }));
    const selected = await findMemberOption("测试用户");
    expect(selected.querySelector("svg")).not.toHaveClass("invisible");
    fireEvent.click(screen.getByRole("button", { name: "Unassigned" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ assignee_type: null, assignee_id: null });
  });

  it.each([member.id, member.user_id])("marks the existing member selected for identity %s", async (id) => {
    renderPicker(id);
    fireEvent.click(screen.getByRole("button", { name: "测试用户" }));
    const selected = await findMemberOption("测试用户");
    expect(selected.querySelector("svg")).not.toHaveClass("invisible");
    expect(screen.getByRole("button", { name: "Unassigned" })).toBeInTheDocument();
  });

  it("sorts members by the stored member-row frequency", async () => {
    const other = { ...member, id: "mem_other", user_id: "usr_other", name: "Other member" };
    renderPicker(null, [other, member], [{ assignee_type: "member", assignee_id: member.id, frequency: 5 }]);
    fireEvent.click(screen.getByRole("button", { name: "Unassigned" }));
    const first = await findMemberOption("测试用户");
    const group = first.parentElement!;
    expect(within(group).getAllByRole("button")[0]).toHaveTextContent("测试用户");
  });
});
