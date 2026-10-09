import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  qc.setQueryData(workspaceKeys.agents("ws-1"), [{ id: "agent-execution", name: "Execution Agent", visibility: "public", archived_at: null }]);
  qc.setQueryData(workspaceKeys.squads("ws-1"), [{ id: "squad-execution", name: "Execution Squad", leader_id: "agent-execution", archived_at: null }]);
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

async function findExecutionOption(name: string) {
  return waitFor(() => {
    const button = screen.getAllByRole("button", { name })
      .find((button) => button.hasAttribute("data-picker-item"));
    expect(button).toBeDefined();
    return button!;
  });
}

describe("AssigneePicker execution ownership", () => {
  it("offers Agent and Squad execution ownership, with root humans configured separately", async () => {
    const { onUpdate } = renderPicker(null);
    fireEvent.click(screen.getByRole("button", { name: "Unassigned" }));
    expect(await findExecutionOption("Execution Squad")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "测试用户" })).toBeNull();
    fireEvent.click(await findExecutionOption("Execution Agent"));
    expect(onUpdate).toHaveBeenCalledWith({ assignee_type: "agent", assignee_id: "agent-execution" });
  });

  it.each([member.id, member.user_id])("preserves historical member identity %s and makes configuration explicit", async (id) => {
    const { onUpdate } = renderPicker(id);
    expect(screen.getByText("测试用户")).toBeInTheDocument();
    expect(screen.getByText("Historical human assignment · execution needs configuration")).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /测试用户/ }));
    expect(screen.getAllByRole("button", { name: /测试用户/ }).filter(button => button.hasAttribute("data-picker-item"))).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Unassigned" })).toBeInTheDocument();
    fireEvent.click(await findExecutionOption("Execution Squad"));
    expect(onUpdate).toHaveBeenCalledWith({ assignee_type: "squad", assignee_id: "squad-execution" });
  });
});
