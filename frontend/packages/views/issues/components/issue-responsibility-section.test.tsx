import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Issue } from "@multiremi/core/types";
import enIssues from "../../locales/en/issues.json";
const mocks = vi.hoisted(() => ({ getIssueResponsibility: vi.fn(), listIssueDeliveries: vi.fn(), listIssueQuestions: vi.fn(), updateIssue: vi.fn(), respondIssueDelivery: vi.fn(), authorizeIssueDelivery: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: mocks }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-human" } }) }));
vi.mock("@multiremi/core/workspace/queries", () => ({ memberListOptions: () => ({ queryKey: ["members", "ws"], queryFn: async () => [{ id: "member-human", user_id: "user-human", name: "Designated human" }, { id: "other-human", user_id: "user-other", name: "Other human" }] }) }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspaceSlug: () => "ws", useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, squadDetail: (id: string) => `/ws/squads/${id}`, inboxItem: (id: string) => `/ws/inbox?item=${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: (props: { href: string; children: React.ReactNode }) => <a {...props} /> }));
import { IssueResponsibilitySection, RootHumanPicker } from "./issue-responsibility-section";
const issue = { id: "root", workspace_id: "ws", parent_issue_id: null, responsible_member_id: "member-human" } as Issue;
const actor = (id: string, type = "agent") => ({ id, type, name: id, issueId: "root" });
const delivery = { id: "delivery", issueId: "root", sourceSessionId: "session", summary: "Formal evidence", status: "pending", submittedBy: actor("execution"), reviewOwner: actor("member-human", "member"), responsibilityRevision: "v3", responseMessageId: null, responseBody: null, authorization: null, createdAt: "now", respondedAt: null };
const responsibility = { issueId: "root", workspaceId: "ws", executionOwner: actor("execution"), reviewOwner: actor("member-human", "member"), rootHuman: actor("member-human", "member"), rootIssueId: "root", unresolved: [], chain: [], revision: "v3" };
function mount(child: React.ReactNode = <IssueResponsibilitySection issue={issue} getActorName={(_type, id) => id} />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>{child}</I18nProvider></QueryClientProvider>);
}
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.getIssueResponsibility.mockResolvedValue(responsibility); mocks.listIssueDeliveries.mockResolvedValue([delivery]); mocks.listIssueQuestions.mockResolvedValue([]); mocks.respondIssueDelivery.mockResolvedValue(delivery); mocks.authorizeIssueDelivery.mockResolvedValue(delivery); mocks.updateIssue.mockResolvedValue(issue); });
describe("responsibility and exact delivery review", () => {
  for (const reason of ["review_issue_closed", "review_issue_archived", "future_unavailable_reason"]) it(`retains pending history and disables review when ${reason}`, async () => {
    mocks.listIssueDeliveries.mockResolvedValue([{ ...delivery, reviewUnavailableReason: reason }]); mount();
    await screen.findByText("Formal evidence");
    expect(await screen.findByRole("status")).toHaveTextContent(reason === "review_issue_closed" ? "Reviewer issue is closed" : reason === "review_issue_archived" ? "Reviewer issue is archived" : "Delivery review is currently unavailable");
    const accept = screen.getByRole("button", { name: "Accept delivery" }), back = screen.getByRole("button", { name: "Return delivery" });
    fireEvent.change(screen.getByRole("textbox", { name: "Reason / review feedback" }), { target: { value: "Retained review feedback" } });
    expect(accept).toBeDisabled(); expect(back).toBeDisabled();
    fireEvent.click(accept); fireEvent.click(back);
    expect(mocks.respondIssueDelivery).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Questions and history" })).toBeInTheDocument();
  });
  it("defaults new roots to the authenticated workspace member, never another member", async () => {
    const onChange = vi.fn(); mount(<RootHumanPicker value={null} onChange={onChange} defaultSelf />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("member-human"));
    expect(onChange).not.toHaveBeenCalledWith("other-human");
  });
  for (const stale of [{isLatest:false},{isLatest:true,invalidatedAt:'earlier-transfer'}]) it(`keeps stale pending delivery history without review or proxy controls: ${JSON.stringify(stale)}`, async () => {
    mocks.listIssueDeliveries.mockResolvedValue([{...delivery,...stale}]); mount();
    await screen.findByText('Formal evidence');
    expect(screen.queryByRole('button',{name:'Accept delivery'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Return delivery'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Authorize coordinator for this delivery'})).toBeNull();
  });
  it("keeps history available with zero pending questions and retains formal return feedback", async () => {
    mount();
    expect(screen.getByRole("button", { name: "Questions and history" })).toBeInTheDocument();
    const back = await screen.findByRole("button", { name: "Return delivery" });
    expect(back).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason / review feedback" }), { target: { value: "Fix regression" } });
    fireEvent.click(back);
    await waitFor(() => expect(mocks.respondIssueDelivery).toHaveBeenCalledWith("root", "delivery", { action: "return", body: "Fix regression", revision: "v3" }));
    fireEvent.click(screen.getByRole("button", { name: "Questions and history" }));
    await waitFor(() => expect(mocks.listIssueQuestions).toHaveBeenCalledWith("root"));
  });
  it("authorizes only the execution coordinator for the exact delivery revision", async () => {
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Authorize coordinator for this delivery" }));
    await waitFor(() => expect(mocks.authorizeIssueDelivery).toHaveBeenCalledWith("root", "delivery", { agentId: "execution", revision: "v3" }));
  });
  it("does not show human review controls when the designated reviewer is another member", async () => {
    mocks.listIssueDeliveries.mockResolvedValue([{ ...delivery, reviewOwner: actor("other-human", "member") }]); mount();
    await screen.findByText("Formal evidence");
    expect(screen.queryByRole("button", { name: "Accept delivery" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Authorize coordinator for this delivery" })).toBeNull();
  });
  it("changes root responsibility explicitly and keeps the historical data intact", async () => {
    mount(); await screen.findByRole("option", { name: "Other human" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "other-human" } });
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Transfer responsibility" }));
    await waitFor(() => expect(mocks.updateIssue).toHaveBeenCalledWith("root", { responsible_member_id: "other-human" }));
  });
  it("does not copy or edit the root human on child issues", async () => {
    mount(<IssueResponsibilitySection issue={{ ...issue, id: "child", parent_issue_id: "root", responsible_member_id: null }} getActorName={(_type, id) => id} />);
    await screen.findByText("Formal evidence"); expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("links a missing inherited human to the root configuration", async () => {
    mocks.getIssueResponsibility.mockResolvedValue({ ...responsibility, rootHuman: null, unresolved: [{ issueId: "root", reason: "human_missing" }] });
    mount(<IssueResponsibilitySection issue={{ ...issue, id: "child", parent_issue_id: "root" }} getActorName={(_type, id) => id} />);
    expect(await screen.findByRole("link", { name: "Configure responsible owner" })).toHaveAttribute("href", "/ws/issues/root");
  });
  it("links a missing squad leader to the assigned squad, without a teammate fallback", async () => {
    mocks.getIssueResponsibility.mockResolvedValue({ ...responsibility, executionOwner: null, unresolved: [{ issueId: "root", reason: "leader_missing" }] });
    mount(<IssueResponsibilitySection issue={{ ...issue, assignee_type: "squad", assignee_id: "team" }} getActorName={(_type, id) => id} />);
    expect(await screen.findByRole("link", { name: "Configure responsible owner" })).toHaveAttribute("href", "/ws/squads/team");
    expect(screen.queryByRole("button", { name: "Authorize coordinator for this delivery" })).toBeNull();
  });
});
