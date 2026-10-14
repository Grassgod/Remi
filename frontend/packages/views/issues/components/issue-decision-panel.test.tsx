import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { issueKeys } from "@multiremi/core/issues/queries";
import { messageFixture } from "../../test/messages";
import enMessages from "../../locales/en/messages.json";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import zhIssues from "../../locales/zh-Hans/issues.json";

const mockApi = vi.hoisted(() => ({
  listIssueSessions: vi.fn(), listMessages: vi.fn(), sendMessage: vi.fn(), getQuestion: vi.fn(), listIssueQuestions: vi.fn(),
}));

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/api")>()),
  api: mockApi,
  getApi: () => mockApi,
  setApiInstance: vi.fn(),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../common/question-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../common/question-card")>()),
  UnifiedQuestionCard: ({ question }: { question: { original_message: string; route_revision: number; wait_status: string } }) => <div>{question.original_message} · revision {question.route_revision} · {question.wait_status}</div>,
}));

import { IssueDecisionBanner, IssueDecisionDrawer, MessageDecisionCard } from "./issue-decision-panel";

function renderBanner(count: number) {
  return render(
    <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      <IssueDecisionBanner count={count} onOpen={vi.fn()} />
    </I18nProvider>,
  );
}

describe("IssueDecisionBanner", () => {
  it("counts the questions waiting for an answer and opens the drawer from its button", () => {
    const onOpen = vi.fn();
    render(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <IssueDecisionBanner count={2} onOpen={onOpen} />
      </I18nProvider>,
    );
    const banner = document.querySelector("[data-issue-decision-banner]")!;
    expect(banner.tagName).toBe("DIV");
    expect(banner).toHaveTextContent("2 questions awaiting an answer");
    const answer = within(banner as HTMLElement).getByRole("button", { name: "Answer" });
    expect(answer).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(answer);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("reads N 个问题待回答 with a 回答问题 action in Chinese", () => {
    render(
      <I18nProvider locale="zh-Hans" resources={{ "zh-Hans": { issues: zhIssues } }}>
        <IssueDecisionBanner count={2} onOpen={vi.fn()} />
      </I18nProvider>,
    );
    expect(document.querySelector("[data-issue-decision-banner]")).toHaveTextContent("2 个问题待回答");
    expect(screen.getByRole("button", { name: "回答问题" })).toBeInTheDocument();
  });

  it("keeps the same fixed-height element when the count changes", () => {
    const { rerender } = renderBanner(1);
    const first = document.querySelector("[data-issue-decision-banner]");
    expect(first).toHaveClass("h-10");
    expect(screen.getByText("1 question awaiting an answer")).toBeInTheDocument();

    rerender(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <IssueDecisionBanner count={27} onOpen={vi.fn()} />
      </I18nProvider>,
    );
    expect(document.querySelector("[data-issue-decision-banner]")).toBe(first);
    expect(screen.getByText("27 questions awaiting an answer")).toBeInTheDocument();
    expect(first).toHaveClass("h-10");
  });

  it("does not render when nothing waits at the human stage", () => {
    renderBanner(0);
    expect(document.querySelector("[data-issue-decision-banner]")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

const listed = (id: string, patch: Record<string, unknown>) => ({ id, status: "pending", stage: "human", current_handler: null, source_issue_id: "issue-runtime",
  original_message: `${id} question`, route_revision: 1, wait_status: "waiting", ...patch });
function renderDrawer(props: { open: boolean; pendingCount?: number }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const view = render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
    <IssueDecisionDrawer issueId="issue-runtime" onOpenChange={onOpenChange} getActorName={(_type, id) => id} {...props} />
  </I18nProvider></QueryClientProvider>);
  return { ...view, onOpenChange, qc };
}

describe("IssueDecisionDrawer", () => {
  it("loads the subtree's questions only when opened, in the right-side overlay", async () => {
    mockApi.listIssueQuestions.mockReset(); mockApi.listIssueSessions.mockClear(); mockApi.listMessages.mockClear();
    mockApi.listIssueQuestions.mockResolvedValue([listed("native", { route_revision: 2 })]);
    const closed = renderDrawer({ open: false, pendingCount: 1 });
    expect(mockApi.listIssueQuestions).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    closed.unmount();

    renderDrawer({ open: true, pendingCount: 1 });
    expect(await screen.findByText("native question · revision 2 · waiting")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "right");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-issue-decision-overlay");
    expect(within(screen.getByRole("dialog")).getByText("Questions")).toBeInTheDocument();
    expect(mockApi.listIssueQuestions).toHaveBeenCalledWith("issue-runtime");
    expect(mockApi.listIssueSessions).not.toHaveBeenCalled();
    expect(mockApi.listMessages).not.toHaveBeenCalled();
  });

  it("counts this issue's human-stage questions like the banner, labels sub-issues', and folds settled ones", async () => {
    mockApi.listIssueQuestions.mockReset();
    mockApi.listIssueQuestions.mockResolvedValue([
      listed("child-human", { source_issue_id: "child" }),
      listed("agent-held", { stage: "parent_owner", current_handler: { type: "agent", id: "lead" } }),
      listed("own-human", {}),
      listed("answered", { status: "answered", wait_status: "consumed" }),
      listed("closed", { status: "closed", wait_status: "detached" }),
    ]);
    renderDrawer({ open: true, pendingCount: 1 });
    await screen.findByText("own-human question · revision 1 · waiting");
    const pending = screen.getByRole("region", { name: "Awaiting answers" });
    const subIssues = screen.getByRole("region", { name: enIssues.responsibility.sub_issue_pending_section });
    const agent = screen.getByRole("region", { name: "Waiting for an Agent" });
    const history = screen.getByRole("region", { name: "Answered and closed" });
    expect([...pending.querySelectorAll("div")].map(card => card.textContent)).toEqual(["own-human question · revision 1 · waiting"]);
    expect([...subIssues.querySelectorAll("div")].map(card => card.textContent)).toEqual(["child-human question · revision 1 · waiting"]);
    expect(within(agent).getByText("agent-held question · revision 1 · waiting")).toBeInTheDocument();
    // The banner's scope: one question of this issue, never the sub-issue's or the Agent-held one.
    expect(within(screen.getByRole("dialog")).getByText("1 question awaiting an answer")).toBeInTheDocument();
    const toggle = within(history).getByRole("button", { name: "Answered and closed (2)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(history).queryByText(/answered question|closed question/)).toBeNull();
    fireEvent.click(toggle);
    expect(within(history).getByText("answered question · revision 1 · consumed")).toBeInTheDocument();
    expect(within(history).getByText("closed question · revision 1 · detached")).toBeInTheDocument();
  });

  it("keeps an answered question where it was while the drawer stays open", async () => {
    mockApi.listIssueQuestions.mockReset();
    mockApi.listIssueQuestions.mockResolvedValue([listed("own-human", {})]);
    const view = renderDrawer({ open: true, pendingCount: 1 });
    await screen.findByText("own-human question · revision 1 · waiting");
    act(() => view.qc.setQueryData(issueKeys.questions("ws-1", "issue-runtime"), [listed("own-human", { status: "answered", wait_status: "consumed" })]));
    const answered = await screen.findByText("own-human question · revision 1 · consumed");
    expect(screen.getByRole("region", { name: "Awaiting answers" })).toContainElement(answered);
    expect(screen.queryByRole("region", { name: "Answered and closed" })).toBeNull();
    expect(screen.getByText("No questions awaiting an answer")).toBeInTheDocument();
  });

  it("says nothing waits once every listed question is settled or held by an Agent", async () => {
    mockApi.listIssueQuestions.mockReset();
    mockApi.listIssueQuestions.mockResolvedValue([
      listed("agent-held", { stage: "issue_owner", current_handler: { type: "agent", id: "owner" } }),
      listed("answered", { status: "answered", wait_status: "consumed" }),
    ]);
    renderDrawer({ open: true, pendingCount: 1 });
    expect(await screen.findByText("No questions awaiting an answer")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Awaiting answers" })).toBeNull();
  });

  it("uses the detail count until the list arrives and shows an empty state", async () => {
    let resolve: (value: unknown[]) => void = () => {};
    mockApi.listIssueQuestions.mockReset();
    mockApi.listIssueQuestions.mockReturnValue(new Promise(done => { resolve = done; }));
    renderDrawer({ open: true, pendingCount: 3 });
    expect(await screen.findByText("3 questions awaiting an answer")).toBeInTheDocument();
    resolve([]);
    expect(await screen.findByText("No questions yet")).toBeInTheDocument();
    expect(screen.getByText("No questions awaiting an answer")).toBeInTheDocument();
  });

  it("offers a retry when the questions cannot be loaded", async () => {
    mockApi.listIssueQuestions.mockReset();
    mockApi.listIssueQuestions.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([listed("own-human", {})]);
    renderDrawer({ open: true, pendingCount: 1 });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: enIssues.detail.decision_retry }));
    expect(await screen.findByText("own-human question · revision 1 · waiting")).toBeInTheDocument();
  });
});

const decision = messageFixture({ message_kind: "decision", body_md: "Merge after QA?", options: [{ label: "Merge", value: "approve" }] });
function mountPanel(message = decision) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockApi.listIssueSessions.mockResolvedValue([{ id: "sess_1" }]);
  mockApi.listMessages.mockResolvedValue({ messages: [decision], next_cursor: null });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat, messages: enMessages } }}>
    <MessageDecisionCard message={message} canAnswer getActorName={(_type, id) => id} />
  </I18nProvider></QueryClientProvider>);
}
describe("decision message replies", () => {
  it.each(["human_request", "decision_record"])("reads historical %s through the original Q projection without the retired reply path", async metadataKey => {
    mockApi.sendMessage.mockClear(); mockApi.getQuestion.mockClear();
    mockApi.getQuestion.mockResolvedValue({ original_message: "Historical original question", route_revision: 9, wait_status: "detached" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const metadata = metadataKey === "decision_record"
      ? { decision_record: { status: "pending", issue_id: "iss_actual_source" } }
      : { human_request: { status: "pending" } };
    render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}><MessageDecisionCard message={{ ...decision, metadata }} canAnswer /></I18nProvider></QueryClientProvider>);
    expect(await screen.findByText("Historical original question · revision 9 · detached")).toBeInTheDocument();
    expect(mockApi.getQuestion).toHaveBeenCalledWith(decision.id);
    expect(mockApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });
  it.each([{}, { decision_record: { status: "pending" } }, { message_choice: { status: "pending" } }])("posts an ordinary choice exactly once with its original option and reply reference (%j)", async metadata => {
    mockApi.listMessages.mockClear(); mockApi.getQuestion.mockClear(); mockApi.sendMessage.mockClear();
    mockApi.sendMessage.mockResolvedValue({ message: {} }); mountPanel({ ...decision, metadata });
    expect(mockApi.listMessages).not.toHaveBeenCalled();
    expect(screen.getByText("Merge after QA?")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByRole("button", { name: "Resolved" });
    expect(mockApi.sendMessage).toHaveBeenCalledWith("sess_1", expect.objectContaining({
      body_md: "Merge", message_kind: "reply", reply_to_id: "msg_1", metadata: { selected_options: ["approve"] },
    }));
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockApi.getQuestion).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });
  it("shows a duplicate-answer conflict without marking the reply successful", async () => {
    mockApi.sendMessage.mockRejectedValue(new Error("Decision is settled")); mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Decision is settled");
    expect(screen.getByRole("button", { name: "Merge" })).toHaveAttribute("aria-pressed", "true");
  });
});
